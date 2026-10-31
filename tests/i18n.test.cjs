const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { t, ht, setLocale, getLocale, isLocale } = require('../electron/i18n.mjs');
const english = require('../electron/locales/en.json');
const { FileStore, DEFAULT_SETTINGS, validateSettings } = require('../electron/file-store.cjs');
const { shortcutCatalog } = require('../electron/shortcuts.mjs');

test('language preference migrates, validates and persists without applying mid-session', async context => {
  const output = path.resolve(__dirname, '../test-results'); await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'i18n-'));
  context.after(() => fs.rm(profile, { recursive: true, force: true }));
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { theme: 'night', locale: 'invalid' } }));
  const store = new FileStore(profile); await store.init();
  assert.equal(DEFAULT_SETTINGS.locale, 'zh-CN');
  assert.equal(store.metadata.settings.locale, 'zh-CN');
  assert.equal(store.metadata.settings.theme, 'night');
  for (const locale of [null, 0, {}, 'EN', 'en-US', 'zh', 'fr', 'en\0']) {
    assert.equal(isLocale(locale), false);
    assert.throws(() => validateSettings({ locale }), /Invalid setting/);
  }
  setLocale('zh-CN');
  await store.updateSettings({ locale: 'en' });
  assert.equal(getLocale(), 'zh-CN');
  const reopened = new FileStore(profile); await reopened.init();
  assert.equal(reopened.metadata.settings.locale, 'en');
  assert.equal(reopened.metadata.settings.theme, 'night');
});

test('translations keep dynamic data opaque, escape HTML literals and preserve shortcut labels', () => {
  try {
    setLocale('en');
    assert.equal(t('保存'), 'Save');
    assert.equal(t('关闭 {0}', '保存 {0}.md'), 'Close 保存 {0}.md');
    assert.equal(t('没有此词条'), '没有此词条');
    assert.equal(ht('保存 <img src=x> & "\' {0}', '<strong>safe</strong>'), '保存 &lt;img src=x&gt; &amp; &quot;&#39; <strong>safe</strong>');
    assert.equal(shortcutCatalog.find(item => item.id === 'save').label, 'Save');
    assert.match(ht('可用 $&#123;filename&#125; 代表文稿名，例如 images/$&#123;filename&#125;。仅影响之后插入、整理或下载的图片；原有图片保持原样。'), /\$&#123;filename&#125;/);
    setLocale('zh-CN');
    assert.equal(t('关闭 {0}', 'Save.md'), '关闭 Save.md');
    assert.equal(shortcutCatalog.find(item => item.id === 'save').label, '保存');
    setLocale('unsupported'); assert.equal(getLocale(), 'zh-CN');
  } finally { setLocale('zh-CN'); }
});

test('English catalog covers source message calls and keeps each interpolation placeholder', async () => {
  const placeholders = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort();
  for (const [key, value] of Object.entries(english)) {
    assert.equal(typeof value, 'string', key); assert.ok(value.trim(), key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
  let calls = 0;
  for (const directory of ['src', 'electron']) {
    for (const name of await fs.readdir(path.join(__dirname, '..', directory))) {
      if (!/\.(?:ts|cjs|mjs)$/.test(name) || /\.d\./.test(name)) continue;
      const source = await fs.readFile(path.join(__dirname, '..', directory, name), 'utf8');
      // Only literal arguments are message keys. Dynamic data must stay parameters.
      for (const match of source.matchAll(/\b(?:t|ht)\(("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
        const key = match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1).replace(/\\'/g, "'");
        assert.ok(Object.hasOwn(english, key), `${directory}/${name}: missing ${key}`); calls++;
      }
    }
  }
  assert.ok(calls > 1400, `Expected full UI coverage, got ${calls}`);
});

test('installed bootstrap and activated update module copies share one effective language', async () => {
  const updated = await import('../electron/i18n.mjs?activated-update');
  try {
    setLocale('en'); assert.equal(updated.t('保存'), 'Save');
    updated.setLocale('zh-CN'); assert.equal(t('保存'), '保存');
  } finally { setLocale('zh-CN'); }
});

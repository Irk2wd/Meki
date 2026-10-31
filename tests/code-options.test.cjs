const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, validateSettings } = require('../electron/file-store.cjs');
const { validateClipboardText, registerClipboardText, MAX_CLIPBOARD_BYTES } = require('../electron/clipboard-text.cjs');

test('code defaults match existing indentation and only language policy affects a new block', async () => {
  const { codeDefaults, newCodeLanguage, validCodeLanguage } = await import('../src/code-options.ts');
  for (const [key, value] of Object.entries(codeDefaults)) assert.equal(DEFAULT_SETTINGS[key], value, key);
  assert.equal(codeDefaults.codeWrap, false); assert.equal(codeDefaults.codeIndentSize, 2); assert.equal(codeDefaults.codeTabSize, 4); assert.equal(codeDefaults.codeAutoIndent, true);
  assert.equal(newCodeLanguage({ ...codeDefaults, codeDefaultLanguage: 'python', codeLastLanguage: 'cpp' }), '');
  assert.equal(newCodeLanguage({ ...codeDefaults, codeLanguageMode: 'default', codeDefaultLanguage: 'python', codeLastLanguage: 'cpp' }), 'python');
  assert.equal(newCodeLanguage({ ...codeDefaults, codeLanguageMode: 'last', codeLastLanguage: 'c++' }), 'c++');
  for (const name of ['c++', 'c#', 'objective-c', 'common_lisp', 'JavaScript', '']) assert.equal(validCodeLanguage(name), true);
  for (const name of ['a\n```', '<script>', '../evil', 'x'.repeat(41)]) assert.equal(validCodeLanguage(name), false);
});
test('code settings reject invalid widths, flags, language policies and fence injections', () => {
  const valid = { codeWrap: true, codeIndentSize: 8, codeUseTabs: true, codeTabSize: 1, codeAutoIndent: false, codeLanguageMode: 'last', codeDefaultLanguage: 'c++', codeLastLanguage: 'python' };
  for (const [key, value] of Object.entries(valid)) assert.equal(validateSettings(valid)[key], value);
  for (const key of ['codeIndentSize', 'codeTabSize']) for (const value of [0, 9, 2.5, NaN, '4']) assert.throws(() => validateSettings({ [key]: value }), /Invalid setting/);
  for (const patch of [{ codeWrap: 1 }, { codeAutoIndent: 'false' }, { codeUseTabs: null }, { codeLanguageMode: 'unknown' }, { codeDefaultLanguage: 'js\n```' }, { codeLastLanguage: '../run' }]) assert.throws(() => validateSettings(patch), /Invalid setting/);
});
test('export code wraps only on request on screen, but always wraps in print', async () => {
  const { codeAppearance } = await import('../src/code-options.ts');
  const normal = codeAppearance(), wrapped = codeAppearance({ codeWrap: true, codeTabSize: 8 });
  assert.match(normal, /white-space:pre;/); assert.match(normal, /tab-size:4;/);
  assert.match(wrapped, /white-space:pre-wrap;/); assert.match(wrapped, /tab-size:8;/);
  for (const css of [normal, wrapped]) { assert.match(css, /@media print\{[^]*white-space:pre-wrap!important/); assert.match(css, /\.cm-content/); assert.match(css, /overflow-wrap:anywhere!important/); }
});
test('text clipboard bridge accepts only bounded text and never reads other clipboard formats', async () => {
  assert.equal(validateClipboardText('中文\r\n**literal**'), '中文\r\n**literal**');
  for (const value of [null, {}, Buffer.from('x'), 'x\0', '汉'.repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3))]) assert.throws(() => validateClipboardText(value), /剪贴板/);
  const handlers = new Map(); let copied;
  registerClipboardText((name, handler) => handlers.set(name, handler), { readText: async () => 'Text only', writeText: async text => { copied = text; } });
  assert.deepEqual([...handlers.keys()], ['read-clipboard-text', 'write-clipboard-text']);
  assert.equal(await handlers.get('read-clipboard-text')(), 'Text only');
  await handlers.get('write-clipboard-text')('# Title'); assert.equal(copied, '# Title');
  assert.throws(() => handlers.get('write-clipboard-text')({ html: '<h1>not text</h1>' }), /剪贴板/);
});

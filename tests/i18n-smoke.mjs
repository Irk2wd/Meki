import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'i18n-'))), profile = path.join(run, 'profile');
await fs.mkdir(profile);
const file = path.join(run, '保存.md'), original = '\uFEFF# 保存\r\n\r\n当前设置 / Save / 中文文稿 {0}\r\n';
await fs.writeFile(file, original);
await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { autoSnapshot: false, theme: 'linen' } }));
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'cancel' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const results = [], errors = []; let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function poll(check, label) { const until = Date.now() + 20000; while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw Error(`Timed out: ${label}`); }
async function ready(target) { target.setDefaultTimeout(15000); target.on('pageerror', error => errors.push(error.message)); await target.waitForSelector('#shell[data-ready="true"]'); return target; }
async function focus(target = page) { await (await app.browserWindow(target)).evaluate(win => { win.show(); win.focus(); }); await target.waitForFunction(() => document.hasFocus()); }
async function launch(args = []) {
  app = await electron.launch({ executablePath: require('electron'), args: [root, ...args], env, timeout: 30000 });
  page = await ready(await app.firstWindow()); await focus();
}
async function stop() { if (!app) return; await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; }
async function action(name, target = page) { await target.waitForFunction(() => !document.body.classList.contains('is-busy')); await target.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); }
async function buffer() { return page.locator('#source-editor .cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n')); }
async function session() { return JSON.parse(await fs.readFile(path.join(profile, 'windows-v1.json'), 'utf8')); }
async function nativeLabels() { return app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label)); }
async function language(value, target = page) {
  if (!await target.locator('#style-panel').isVisible()) await action('style', target);
  await target.locator('#ui-language').selectOption(value);
  await poll(async () => (await target.evaluate(() => window.moye.boot())).settings.locale === value, 'language persisted');
  await target.waitForFunction(() => !document.querySelector('#ui-language').disabled);
}
async function noChinese(selector) {
  const text = await page.locator(selector).innerText(); assert.doesNotMatch(text, /[\p{Script=Han}]/u, `${selector}: ${text}`);
}
try {
  await launch(['--open', file]);
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.ok((await nativeLabels()).includes('文件'));
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(end); await page.keyboard.insertText('\n未保存内容 / Unsaved text');
  const unsaved = await buffer();
  await poll(async () => (await session()).windows.some(win => win.session?.documents.some(doc => doc.content.includes('Unsaved text'))), 'recovery buffer saved');
  await language('en');
  assert.match(await page.locator('#language-restart-note').innerText(), /退出并重新打开/);
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await buffer(), unsaved); assert.equal(await fs.readFile(file, 'utf8'), original);
  pass('old profiles default to Chinese; changing language preserves unsaved text and original BOM/CRLF bytes');

  const created = app.waitForEvent('window'); await page.evaluate(() => window.moye.newWindow());
  const second = await ready(await created); await focus(second);
  assert.equal(await second.locator('html').getAttribute('lang'), 'zh-CN');
  await language('zh-CN', second);
  await poll(async () => await page.locator('#ui-language').inputValue() === 'zh-CN', 'preference broadcasts');
  await language('en', second);
  assert.equal((await second.evaluate(() => window.moye.boot())).locale, 'zh-CN');
  assert.ok((await nativeLabels()).includes('文件'));
  await action('style', second);
  await second.locator('[data-mode="source"]').click();
  await second.locator('#source-editor .cm-content').click(); await second.keyboard.insertText('Second window text');
  await poll(async () => (await session()).windows.some(win => win.session?.documents.some(doc => doc.content === 'Second window text')), 'second window buffer persisted');
  pass('open and new windows share a pending preference while the active language stays consistent until restart');

  await stop(); await launch();
  await poll(() => app.windows().length === 2, 'two restored windows');
  const windows = await Promise.all(app.windows().map(ready));
  page = windows.find(target => target === page) || windows[0];
  for (const target of windows) {
    assert.equal(await target.locator('html').getAttribute('lang'), 'en');
    assert.equal((await target.evaluate(() => window.moye.boot())).locale, 'en');
    if (await target.locator('#document-name').innerText() === '保存.md') page = target;
  }
  await focus();
  assert.equal(await buffer(), unsaved);
  assert.equal(await page.locator('#document-name').innerText(), '保存.md');
  assert.equal(await page.locator('[data-action="open"] span').innerText(), 'Open file');
  assert.equal(await page.locator('[data-action="save"] span').innerText(), 'Save');
  assert.ok((await nativeLabels()).includes('File')); assert.ok(!(await nativeLabels()).includes('文件'));
  const saveLabel = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-save').label);
  assert.equal(saveLabel, 'Save');
  pass('restart applies English to every restored window and native menu without translating document names or recovery contents');

  await page.keyboard.press(`${mod}+f`); await page.locator('#find-query').fill('['); await page.locator('#find-regex').check();
  await page.waitForFunction(() => document.querySelector('#find-feedback').textContent.startsWith('Invalid regular expression:'));
  assert.equal(await page.locator('#find-query').getAttribute('placeholder'), 'Find in current document');
  await page.locator('[data-action="find-close"]').click();
  pass('find labels and worker-generated regular-expression errors use English');

  for (const [command, selector] of [['about', '#about-dialog'], ['image-hosting', '#image-host-dialog'], ['snapshots', '#snapshot-dialog'], ['shortcut-settings', '#shortcuts-dialog'], ['export-options', '#export-dialog'], ['help', '#help-dialog']]) {
    await action(command); await page.locator(selector).waitFor({ state: 'visible' });
    // User filenames may legitimately be Chinese in snapshots. Inspect its static heading.
    await noChinese(command === 'snapshots' ? `${selector} h2` : selector);
    if (command === 'image-hosting') assert.match(await page.locator(selector).innerText(), /\$\{filename\}/);
    await page.keyboard.press('Escape'); await page.locator(selector).waitFor({ state: 'hidden' });
  }
  await action('updates'); await page.locator('#update-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#update-message').innerText(), /Click “Check for updates”/);
  await page.keyboard.press('Escape');
  pass('About, image hosting, snapshots, shortcuts, export, guide and update dialogs use English, including dynamic labels');

  const presetName = '保存 <em>预设</em>';
  await action('export-options'); await page.locator('#export-dialog').waitFor({ state: 'visible' });
  await page.locator('#export-preset-name').fill(presetName); await page.locator('#save-as-export-preset').click();
  await page.waitForFunction(() => document.querySelector('#export-feedback').textContent === 'Export preset saved.');
  assert.equal(await page.locator('#export-preset option:checked').textContent(), presetName);
  assert.equal(await page.locator('#export-preset em').count(), 0);
  await page.keyboard.press('Escape');
  const exported = path.join(run, 'english-ui-chinese-document.html');
  await app.evaluate((_electron, filename) => { process.env.MOYE_TEST_EXPORT_PATH = filename; }, exported);
  await action('export-html');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Exported HTML'));
  const html = await fs.readFile(exported, 'utf8');
  assert.match(html, /<html lang="en">/); assert.match(html, /<title>保存.md<\/title>/);
  assert.match(html, /中文文稿/); assert.match(html, /未保存内容/);
  assert.equal(await buffer(), unsaved);
  pass('Chinese custom preset names remain escaped user data; English HTML metadata preserves Chinese document text and title');

  await action('style');
  assert.equal(await page.locator('#ui-language').inputValue(), 'en');
  assert.equal(await page.locator('#language-restart-note').isVisible(), false);
  await page.screenshot({ path: path.join(run, 'english-settings.png') });
  await (await app.browserWindow(page)).evaluate(win => win.setSize(680, 650));
  const fit = await page.locator('#style-panel').evaluate(node => { const r = node.getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, overflow: node.scrollWidth > node.clientWidth }; });
  assert.deepEqual(fit, { fits: true, overflow: false });
  await page.screenshot({ path: path.join(run, 'english-narrow.png') });
  pass('English appearance settings remain usable in a narrow window');

  await language('zh-CN'); await stop(); await launch();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.ok((await nativeLabels()).includes('文件'));
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(errors, []);
  pass('switching back restores Chinese and keeps the original document unchanged without renderer errors');
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify({ passed: results.length, results, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(run, 'failure.txt'), `${error.stack}\n${errors.join('\n')}`); throw error;
} finally { await stop(); console.log(`Evidence: ${run}`); }

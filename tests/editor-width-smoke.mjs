import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'editor-width-')));
const file = path.join(run, 'width.md'), html = path.join(run, 'export.html'), profile = path.join(run, 'profile');
const original = '\uFEFF# Editor width\r\n\r\nTables and code share the available writing space.\r\n\r\n| Name | Input | Quality | Time | Memory | Result | Notes |\r\n| --- | --- | --- | --- | --- | --- | --- |\r\n| Adaptive | Scene A | High | 12.8 ms | 2.4 GB | Complete | Keep details |\r\n\r\n```typescript\r\nconst result = evaluate(scene, { resolution: [2560, 1440], quality: "high", preserveBoundaryDetails: true });\r\n```\r\n';
await fs.writeFile(file, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_DISCARD: 'discard', MEKI_TEST_EXPORT_HTML_PATH: html };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, cdp; const results = [], errors = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function ready(target) { target.setDefaultTimeout(15000); target.on('pageerror', error => errors.push(error.message)); await target.waitForSelector('#shell[data-ready="true"]'); return target; }
async function launch() {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await ready(await app.firstWindow()); cdp = await page.context().newCDPSession(page);
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 850); win.show(); win.focus(); });
  await page.locator('.milkdown-code-block .cm-content').waitFor(); await page.evaluate(() => document.fonts.ready);
}
async function stop() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function action(name, target = page) { await target.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await target.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function viewport(width) { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await frames(); }
async function settings() { if (!await page.locator('#style-panel').isVisible()) await action('style'); }
async function unlimited(value) {
  await settings();
  if (!await page.locator('.layout-settings').evaluate(node => node.open)) await page.locator('.layout-settings summary').click();
  await page.locator('#unlimited-width').setChecked(value);
  await page.waitForFunction(async value => (await window.meki.boot()).settings.unlimitedWidth === value, value);
  assert.equal(await page.locator('#line-width').isDisabled(), value);
  await action('style'); await frames();
}
async function width(value) { await settings(); await page.locator('#line-width').selectOption(String(value)); await action('style'); await frames(); }
async function geometry(limit) {
  const data = await page.locator('#visual-editor').evaluate(host => {
    const scroll = host.closest('.document-scroll'), editor = host.querySelector('.milkdown > .ProseMirror'), style = getComputedStyle(host);
    const rect = editor.getBoundingClientRect();
    return { available: scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), width: rect.width, pane: scroll.clientWidth, scroll: scroll.scrollWidth,
      blocks: [...editor.querySelectorAll('.milkdown-table-block,.milkdown-code-block')].map(node => { const block = node.getBoundingClientRect(); return { left: block.left - rect.left, right: block.right - rect.right }; }) };
  });
  assert.ok(Math.abs(data.width - Math.min(limit, data.available)) < 2, JSON.stringify(data));
  assert.ok(data.scroll <= data.pane + 1, 'Only individual content blocks may scroll horizontally');
  assert.ok(data.blocks.every(block => block.left >= -1 && block.right <= 1), 'Tables and code must stay inside the writing area');
  return data;
}
try {
  await launch(); await viewport(2560);
  const defaults = (await page.evaluate(() => window.meki.boot())).settings;
  assert.equal(defaults.unlimitedWidth, false); assert.equal(defaults.lineWidth, 1040);
  assert.equal((await geometry(1040)).width, 1040);
  await page.locator('#sidebar-settings-button').click(); await page.locator('[data-sidebar-setting="style"]').click();
  assert.equal(await page.locator('.layout-settings').evaluate(node => node.open), false);
  assert.equal(await page.locator('#unlimited-width').isVisible(), false); await action('style');
  pass('default writing width is capped at 1040px and the uncommon option is collapsed inside settings');

  await unlimited(true); assert.ok((await geometry(Infinity)).width > 1200);
  await page.screenshot({ path: path.join(run, 'unlimited-wide.png') });
  await viewport(760); await geometry(Infinity); await page.screenshot({ path: path.join(run, 'unlimited-narrow.png') });
  pass('unlimited width uses the available viewport and retains safe gutters when the window narrows');

  await viewport(2560); await unlimited(false); await width(640);
  await unlimited(true); await geometry(Infinity); await unlimited(false); assert.equal((await geometry(640)).width, 640);
  await width(1200); assert.equal((await geometry(1200)).width, 1200); await viewport(1000); await geometry(1200);
  pass('disabling unlimited width restores the saved compact width and the 1200px preset still adapts to smaller windows');

  await viewport(2560); await width(900); await unlimited(true);
  await page.locator('[data-mode="source"]').click(); await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' }); await frames();
  const source = await page.locator('#source-editor .cm-editor').evaluate(node => ({ width: node.getBoundingClientRect().width, available: node.closest('.document-scroll').clientWidth }));
  assert.ok(source.width > 1200 && Math.abs(source.width - source.available) < 2);
  await page.locator('[data-mode="visual"]').click(); await geometry(Infinity);
  await action('export-html');
  await page.waitForFunction(() => !document.body.classList.contains('is-busy'));
  assert.match(await fs.readFile(html, 'utf8'), /max-width:900px/);
  pass('visual and source modes share unlimited width while standalone HTML keeps its saved export width');

  await stop(); await launch(); await viewport(2560);
  const restored = (await page.evaluate(() => window.meki.boot())).settings;
  assert.equal(restored.unlimitedWidth, true); assert.equal(restored.lineWidth, 900); await geometry(Infinity);
  pass('the optional layout and original width preference survive a full application restart');

  const created = app.waitForEvent('window'); await page.evaluate(() => window.meki.newWindow());
  const second = await ready(await created);
  assert.equal(await second.locator('body').evaluate(node => node.classList.contains('unlimited-width')), true);
  await unlimited(false);
  await second.waitForFunction(() => !document.body.classList.contains('unlimited-width'));
  assert.equal((await geometry(900)).width, 900);
  pass('layout changes reach existing and newly opened native windows without changing the saved width');

  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  assert.deepEqual(errors, []); pass('layout changes preserve original BOM/CRLF Markdown and cause no renderer errors');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  await stop(); console.log(`Evidence: ${run}`);
}

import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'tab-layout-')));
const names = ['短.md', 'UniLOD相关工作初版报告.md', 'VeryLongTechnicalDocumentNameWithoutAnySpacesAndWithLotsOfDetails.md', '实验结果与多层级混合渲染性能对比_最终版本.md', 'notes.md', '一个用于检查关闭按钮与文稿名称之间排布关系的超长文件名称.md'];
const files = names.map(name => path.join(run, name)), original = '# Tab layout\n\nKeep all files unchanged.\n';
for (const file of files) await fs.writeFile(file, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
let app, page; const results = [], errors = [], samples = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await idle(); }
async function size(width) { await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width); await frames(); }
async function activate(name) {
  await page.locator('.document-tab [role=tab]').filter({ hasText: name }).evaluate(node => node.click());
  await page.waitForFunction(name => document.querySelector('#document-name').textContent === name && !document.body.classList.contains('is-busy'), name); await frames();
}
async function verify(label) {
  const strips = await page.locator('.document-tab-list:visible,.pane-tab-list:visible').evaluateAll(nodes => nodes.map(strip => {
    const rect = node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
    const active = strip.querySelector('.document-tab.active');
    return { bounds: rect(strip), active: active ? rect(active) : null, close: active ? rect(active.querySelector('[data-close-tab]')) : null,
      tabs: [...strip.querySelectorAll('.document-tab')].map(tab => ({ tab: rect(tab), name: rect(tab.querySelector('[role=tab] > span:nth-child(2)')), close: rect(tab.querySelector('[data-close-tab]')) })) };
  }));
  for (const strip of strips) {
    assert.ok(strip.active && strip.close, label);
    assert.ok(strip.active.left >= strip.bounds.left - 1 && strip.active.right <= strip.bounds.right + 1, `${label}: complete active tab must be visible: ${JSON.stringify(strip)}`);
    assert.ok(strip.close.width >= 24 && strip.close.left >= strip.bounds.left - 1 && strip.close.right <= strip.bounds.right + 1, `${label}: close button is clipped`);
    for (const tab of strip.tabs) {
      assert.ok(tab.name.right <= tab.close.left + 1 && tab.close.right <= tab.tab.right + 1, `${label}: filename overlaps its close button`);
      assert.equal(tab.close.width, 26); assert.equal(tab.close.height, 26);
      assert.ok(Math.abs((tab.close.top + tab.close.bottom) / 2 - (tab.tab.top + tab.tab.bottom - 2) / 2) < 1, `${label}: close button is not vertically centered`);
    }
  }
  const controls = await page.locator('.document-tabs > button:visible,.pane-merge:visible').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect();
    return box.left >= parent.left && box.right <= parent.right && box.width > 20;
  }));
  assert.ok(controls.every(Boolean), `${label}: fixed controls must fit`);
  samples.push({ label, strips });
}
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', files[0]] : [root, '--open', files[0]], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#shell[data-ready="true"]'); await size(1280);
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  for (const file of files.slice(1)) {
    await app.evaluate((_electron, file) => { process.env.MEKI_TEST_OPEN_PATH = file; }, file); await action('open');
    await page.waitForFunction(file => document.querySelector('#document-name').title === file, file);
  }
  for (const width of [1280, 800, 480, 1000, 1280]) {
    await size(width); await verify(`resize-${width}`);
    assert.equal((await page.locator('.document-tabs').boundingBox()).height, 38);
  }
  await page.screenshot({ path: path.join(run, 'long-filenames.png'), clip: { x: 0, y: 0, width: 1280, height: 170 } });
  pass('long Chinese and unbroken English filenames retain a full-size close button as the window narrows and expands');

  await size(800);
  const strip = page.locator('.document-tab-list');
  await strip.hover();
  const before = await strip.evaluate(node => {
    node.scrollLeft = node.scrollWidth;
    return node.scrollLeft;
  });
  assert.ok(before > 0, 'The tab strip must overflow at this width');
  await page.mouse.wheel(0, -500);
  await page.waitForFunction(previous => document.querySelector('.document-tab-list').scrollLeft < previous, before);
  await activate(names[0]); await verify('first-tab'); await activate(names.at(-1)); await verify('last-tab');
  await page.locator('.document-tab.active [role=tab]').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('.document-tab.active [data-close-tab]').evaluate(node => node === document.activeElement), true);
  await verify('keyboard-close-focus');
  pass('mouse wheel, activating distant tabs and keyboard focus keep the name and close control together');

  await page.locator('[data-mode="source"]').click(); await page.locator('#source-editor .cm-content').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.insertText('\nUnsaved tab text');
  await page.waitForFunction(() => !document.querySelector('#dirty-dot').hidden); await verify('dirty-tab');
  assert.equal(await page.locator('.document-tab.active .tab-dirty.visible').count(), 1);
  await action('style'); await page.locator('[data-theme="night"]').click(); await action('style'); await verify('night-theme');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25)); await frames(); await verify('zoom-125');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)); await size(1280);
  pass('dirty state, dark theme and 125% zoom preserve the tab height and close-button alignment');

  await page.locator('.document-tab.active [data-close-tab]').click(); await idle();
  await page.waitForFunction(() => document.querySelectorAll('.document-tab-list .document-tab').length === 5);
  await verify('close-long-tab'); assert.notEqual(await page.locator('#document-name').textContent(), names.at(-1));
  pass('the visible close button closes its own document and keeps the adjacent active tab in view');

  await activate(names[1]);
  const tab = await page.locator('.document-tab.active [role=tab]').boundingBox(), body = await page.locator('.pane-body').boundingBox();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2); await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2 + 15, { steps: 3 });
  await page.mouse.move(body.x + body.width * .94, body.y + body.height * .5, { steps: 15 });
  await page.locator('.pane-drop-preview').waitFor({ state: 'visible' }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 2 && !document.body.classList.contains('is-busy'));
  for (const width of [1280, 800, 600]) { await size(width); await verify(`split-${width}`); }
  assert.equal(await page.locator('.pane-merge:visible').count(), 2);
  await page.locator('.pane-merge:visible').last().click(); await idle();
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 1); await verify('merged-tabs');
  pass('split-pane tabs scroll independently while merge controls stay fixed, and merging restores the top strip');

  for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(errors, []); pass('tab layout and closing preserve original file bytes without renderer errors');
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, samples }, null, 2));
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  console.log(`Evidence: ${run}`);
}

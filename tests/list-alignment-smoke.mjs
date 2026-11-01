import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'list-alignment-')));
const file = path.join(run, 'tasks.md');
const original = '\uFEFF' + ('- [x] 原生文件读写与未保存草稿恢复\n- [ ] 写下你的第一篇笔记\n- [ ] 多行待办：' + '文字换行后仍对齐第一行。'.repeat(8)
  + '\n\n  任务的第二个段落。\n\n  - [ ] 嵌套待办\n  - 嵌套普通列表\n\n1. 有序列表\n2. Ordered item\n\n- 普通列表\n- English item\n').replaceAll('\n', '\r\n');
await fs.writeFile(file, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
const results = [], samples = [], errors = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
const item = text => page.locator('.milkdown-list-item-block > .list-item').filter({ has: page.locator(':scope > .children > .content-dom > p', { hasText: new RegExp('^' + text) }) }).first();
const handle = '.milkdown-block-handle:has(.operation-item)';
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function aligned(text, controls = true) {
  const row = item(text), paragraph = row.locator(':scope > .children > .content-dom > p').first();
  await paragraph.evaluate(node => node.scrollIntoView({ block: 'center' })); await frames();
  const geometry = await row.evaluate(node => {
    const paragraph = node.querySelector(':scope > .children > .content-dom > p');
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) if (text.textContent.trim()) break;
    const range = document.createRange(), start = text.textContent.search(/\S/);
    range.setStart(text, start); range.setEnd(text, start + 1);
    const line = range.getBoundingClientRect(), label = node.querySelector(':scope > .label-wrapper > .label');
    let marker;
    if (label.querySelector('svg')) marker = label.querySelector('svg').getBoundingClientRect();
    else { const digits = document.createRange(); digits.selectNodeContents(label); marker = digits.getBoundingClientRect(); }
    return { x: line.left + 2, y: (line.top + line.bottom) / 2, markerY: (marker.top + marker.bottom) / 2 };
  });
  const markerError = Math.abs(geometry.markerY - geometry.y);
  const sample = { text, markerError }; samples.push(sample);
  assert.ok(markerError < 1, `list marker must align with first text line: ${JSON.stringify({ text, ...geometry, markerError })}`);
  if (controls) {
    await page.mouse.move(geometry.x, geometry.y); await frames();
    const control = await page.locator(handle).evaluate(node => { const rect = node.getBoundingClientRect(); return { y: (rect.top + rect.bottom) / 2, show: node.dataset.show }; });
    sample.handleError = Math.abs(control.y - geometry.y);
    assert.equal(control.show, 'true'); assert.ok(sample.handleError < 1, `block controls must align with ${text}`);
  }
}
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1100, 900); window.show(); });
  await page.waitForSelector('#shell[data-ready="true"]'); await page.evaluate(() => document.fonts.ready); await frames();
  for (const text of ['原生文件', '写下你的', '有序列表', 'Ordered item', '普通列表', 'English item']) await aligned(text);
  await aligned('原生文件'); await page.screenshot({ path: path.join(run, 'task-controls.png') });
  pass('checked and unchecked tasks, bullets and ordered markers align with text and block controls');

  for (const text of ['多行待办', '嵌套待办', '嵌套普通列表']) await aligned(text);
  assert.ok(await item('多行待办').locator(':scope > .children > .content-dom > p').first().evaluate(node => node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) * 2));
  pass('wrapped, multi-paragraph and nested list items use their first text line');

  for (const font of ['serif', 'sans']) for (const size of [14, 18, 24]) {
    await action('style'); await page.locator('#font-family').selectOption(font); await page.locator('#font-size').fill(String(size)); await action('style');
    await page.evaluate(() => document.fonts.ready);
    for (const text of ['原生文件', '写下你的', 'English item']) await aligned(text);
  }
  await action('style'); await page.locator('#font-family').selectOption('serif'); await page.locator('#font-size').fill('18'); await action('style');
  for (const css of ['p { line-height: 2.7; margin-top: 1em; }', 'p { line-height: 1.2; margin-top: 0; }']) {
    await action('custom-theme'); await page.locator('#custom-css').fill(css); await action('apply-theme');
    for (const text of ['原生文件', '写下你的', '嵌套待办']) await aligned(text);
  }
  await action('custom-theme'); await page.locator('#custom-css').fill(''); await action('apply-theme');
  pass('14–24 px serif/sans fonts and custom paragraph spacing keep markers aligned');

  await aligned('原生文件');
  await item('原生文件').locator(':scope > .label-wrapper .checked').click();
  await item('原生文件').locator(':scope > .label-wrapper .unchecked').waitFor();
  await aligned('原生文件');
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await item('原生文件').locator(':scope > .label-wrapper .checked').waitFor(); await aligned('原生文件');
  await page.locator('[data-mode="source"]').click();
  const source = await page.locator('#source-editor .cm-content').innerText();
  assert.match(source, /\[x\] 原生文件读写与未保存草稿恢复/); assert.match(source, /\[ \] 写下你的第一篇笔记/);
  assert.ok(!source.includes('\u200b'), 'layout-only baseline must not enter Markdown');
  await page.locator('[data-mode="visual"]').click(); await aligned('写下你的');
  pass('real checkbox clicks and undo retain task states and never insert layout text into Markdown');

  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(800, 760); window.webContents.setZoomFactor(1.25); });
  await frames();
  for (const text of ['原生文件', '写下你的', '多行待办', '嵌套待办']) await aligned(text);
  await aligned('写下你的'); await page.screenshot({ path: path.join(run, 'narrow-zoom.png') });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1100, 900); });
  pass('narrow windows and 125% page zoom keep checkbox, text and handle aligned');

  await page.emulateMedia({ media: 'print' }); await aligned('原生文件', false); await aligned('嵌套待办', false);
  assert.equal(await page.locator(handle).isVisible(), false); await page.emulateMedia({ media: 'screen' });
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.deepEqual(errors, []);
  pass('print retains list alignment; isolated interaction leaves BOM/CRLF source bytes unchanged');
} finally {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); }
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, samples }, null, 2)); console.log(`Evidence: ${run}`);
}

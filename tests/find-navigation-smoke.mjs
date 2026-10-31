import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'find-navigation-')));
const files = [path.join(run, '查找定位.md'), path.join(run, '另一分栏.md')];
const fixture = '\uFEFF# 查找定位\r\n\r\n' + Array.from({ length: 90 }, (_, index) =>
  `第 ${index} 段：${[0, 45, 89].includes(index) ? '跨**格式**词和 A+B。' : '普通正文，用来检查跨越多屏时的查找定位。'}`).join('\r\n\r\n')
  + '\r\n\r\n```javascript\r\n' + Array.from({ length: 120 }, (_, index) => [0, 60, 119].includes(index) ? '// CodeNeedle' : `const value_${index} = ${index};`).join('\r\n') + '\r\n```\r\n';
for (const file of files) await fs.writeFile(file, fixture);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', home = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
const results = [], errors = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await idle(); await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); }
async function found(index, total = 3) { await page.waitForFunction(({ index, total }) => document.querySelector('#find-count').textContent === `${index} / ${total}`, { index, total }); }
async function selectedText(locator, text) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((node, text) => {
    node.closest('.ProseMirror,.cm-content').focus();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), nodes = []; let item, content = '';
    while ((item = walker.nextNode())) { nodes.push({ node: item, from: content.length }); content += item.textContent; }
    const from = content.indexOf(text); if (from < 0) throw Error('Selection fixture missing');
    const start = nodes.findLast(item => item.from <= from), end = nodes.findLast(item => item.from < from + text.length);
    const range = document.createRange(); range.setStart(start.node, from - start.from); range.setEnd(end.node, from + text.length - end.from);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, text);
  await page.waitForFunction(length => document.querySelector('#selection-count').title === `${length} 个字符（含空白）` && !document.querySelector('#selection-count').hidden, [...text].length);
  assert.equal(await page.evaluate(() => getSelection().toString()), text);
}
async function openFind(expected) {
  await page.keyboard.press(`${mod}+f`);
  await page.waitForFunction(value => document.activeElement?.id === 'find-query' && document.querySelector('#find-query').value === value, expected);
  assert.deepEqual(await page.locator('#find-query').evaluate(node => [node.selectionStart, node.selectionEnd]), [0, expected.length]);
}
function location(mode) {
  const pane = document.querySelector('#document-scroll');
  const scroll = mode === 'source' ? pane.querySelector('.cm-scroller') : pane;
  const hit = pane.querySelector('.moye-search-current'), bounds = scroll.getBoundingClientRect(), rect = hit?.getBoundingClientRect();
  return { top: scroll.scrollTop, visible: !!rect && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1, shellTop: document.querySelector('#shell').getBoundingClientRect().top };
}
async function visible(mode) { await page.waitForFunction(mode => {
  const pane = document.querySelector('#document-scroll'), scroll = mode === 'source' ? pane.querySelector('.cm-scroller') : pane;
  const hit = pane.querySelector('.moye-search-current'); if (!hit) return false;
  const rect = hit.getBoundingClientRect(), bounds = scroll.getBoundingClientRect(); return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
}, mode); return page.evaluate(location, mode); }
async function navigate(mode, direction, index, keyboard = true) {
  const before = await page.evaluate(location, mode);
  if (keyboard) { await page.locator('#find-query').focus(); await page.keyboard.press(direction > 0 ? 'Enter' : 'Shift+Enter'); }
  else await page.locator(`[data-writing-action="${direction > 0 ? 'next' : 'previous'}"]`).click();
  await found(index); const after = await visible(mode);
  assert.ok(Math.abs(after.top - before.top) > 100, `${mode} must reveal a distant match: ${JSON.stringify({ before, after })}`);
  assert.equal(after.shellTop, before.shellTop, 'find navigation must not scroll the application chrome');
  if (keyboard) assert.equal(await page.evaluate(() => document.activeElement?.id), 'find-query');
}
try {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', files[0]] : [root, '--open', files[0]], env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#shell[data-ready="true"]'); await (await app.browserWindow(page)).evaluate(win => { win.show(); win.focus(); }); await page.waitForFunction(() => document.hasFocus());

  await selectedText(page.locator('#visual-editor .ProseMirror > p').first(), '跨格式词'); await openFind('跨格式词'); await found(1); await visible('visual');
  assert.ok(await page.locator('#visual-editor .moye-search-current').count() > 1, 'selection can cross inline formatting');
  pass('Ctrl/Cmd F searches the selected rendered text across inline formatting and selects the query input');
  await navigate('visual', 1, 2); await navigate('visual', 1, 3, false); await navigate('visual', 1, 1); await navigate('visual', -1, 3); await navigate('visual', -1, 2, false);
  await page.screenshot({ path: path.join(run, 'visual-match.png') });
  pass('visual next/previous and wraparound reveal distant matches with keyboard or buttons while retaining find focus');

  await page.locator('#find-regex').check(); await page.locator('#find-query').fill('A.?B'); await found(2);
  await openFind('A.?B'); await found(2);
  await selectedText(page.locator('#visual-editor .ProseMirror > p').first(), 'A+B'); await openFind('A\\+B'); await found(1);
  assert.equal(await page.locator('#find-regex').isChecked(), true);
  await action('find-close'); await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => document.querySelector('#selection-count').hidden);
  await openFind('A\\+B'); await found(2);
  pass('selected punctuation is searched literally with regex enabled, and reopening from the panel or an empty selection preserves the query');

  await page.locator('#find-query').fill('(?=第 89 段)'); await found(1, 1);
  await page.waitForFunction(() => {
    const scroll = document.querySelector('#document-scroll'), target = [...scroll.querySelectorAll('.ProseMirror > p')].find(node => node.textContent.startsWith('第 89 段'));
    const bounds = scroll.getBoundingClientRect(), rect = target.getBoundingClientRect(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  });
  assert.equal(await page.locator('#visual-editor .moye-search-current').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'find-query');
  pass('zero-width regex results reveal their model position even without a highlighted text span');

  await action('find-close'); await page.locator('[data-mode="source"]').click(); await page.locator('#source-editor .cm-content').focus(); await page.keyboard.press(home);
  await selectedText(page.locator('#source-editor .cm-line').filter({ hasText: 'A+B' }).first(), 'A+B'); await openFind('A\\+B'); await found(1); await visible('source');
  assert.equal(await page.locator('#source-editor .cm-search').count(), 0);
  await navigate('source', 1, 2); await navigate('source', 1, 3, false); await navigate('source', 1, 1); await navigate('source', -1, 3); await navigate('source', -1, 2, false);
  await page.screenshot({ path: path.join(run, 'source-match.png') });
  pass('source selection seeds the unified find panel and virtualized matches scroll into view in both directions');

  const beforeMissing = await page.evaluate(location, 'source'); await page.locator('#find-query').fill('missing-keyword'); await found(0, 0);
  await page.locator('#find-query').press('Enter'); await page.locator('#find-query').press('Shift+Enter');
  assert.equal((await page.evaluate(location, 'source')).top, beforeMissing.top);
  pass('no-result navigation does not move the document or reuse a stale match');

  await action('find-close'); await page.locator('[data-mode="visual"]').click(); await action('find'); await page.locator('#find-query').fill('CodeNeedle'); await found(1); await visible('visual');
  assert.ok(await page.locator('#visual-editor .milkdown-code-block .moye-search-current').count() > 0);
  await navigate('visual', 1, 2); await navigate('visual', 1, 3, false); await navigate('visual', -1, 2); await navigate('visual', -1, 1, false);
  await page.screenshot({ path: path.join(run, 'code-match.png') }); await action('find-close');
  assert.equal(await page.locator('#visual-editor .milkdown-code-block .moye-search-hit').count(), 0);
  pass('lazy code blocks highlight results and reveal the exact matching line without taking focus from the find controls');

  await page.locator('[data-mode="source"]').click(); await app.evaluate((_electron, file) => { process.env.MOYE_TEST_OPEN_PATH = file; }, files[1]); await action('open');
  await page.waitForFunction(() => document.querySelector('#document-name').textContent === '另一分栏.md'); await idle();
  const tab = await page.locator('.document-tab.active [role="tab"]').boundingBox(), body = await page.locator('.pane-body').boundingBox();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2); await page.mouse.down(); await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2 + 12, { steps: 3 });
  await page.mouse.move(body.x + body.width * .94, body.y + body.height / 2, { steps: 15 }); await page.locator('.pane-drop-preview').waitFor({ state: 'visible' }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 2 && !document.body.classList.contains('is-busy'));
  await selectedText(page.locator('#visual-editor .ProseMirror > p').first(), '跨格式词'); await openFind('跨格式词'); await found(1); await visible('visual');
  const peer = page.locator('.editor-pane:not(.active-pane) .source-editor .cm-scroller'), peerTop = await peer.evaluate(node => node.scrollTop);
  await navigate('visual', 1, 2); await navigate('visual', 1, 3, false);
  assert.equal(await peer.evaluate(node => node.scrollTop), peerTop);
  await page.screenshot({ path: path.join(run, 'pane-match.png') });
  pass('find follows the active pane and scrolling its matches leaves the neighboring editor in place');

  await action('find-close'); await action('save'); await idle();
  for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), fixture);
  assert.deepEqual(errors, []); pass('find leaves exact BOM/CRLF document bytes unchanged and produces no renderer exceptions');
} finally {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => '')); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  console.log(`Evidence: ${run}`);
}

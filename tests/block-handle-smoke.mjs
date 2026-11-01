import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'block-handle-')));
const file = path.join(run, 'blocks.md');
const original = '# 段落控件\n\nAlpha 第一段。\n\nBeta 第二段。\n\nGamma 第三段。\n\n## 多行标题对齐验证：' + '文字会自然换行，按钮应跟随第一行。'.repeat(6)
  + '\n\n' + '长段落：对齐第一行，悬停不应改变正文。'.repeat(30) + '\n\n- 清单第一项\n- 清单第二项\n\n> 引用文字\n>\n> 第二段引用\n\n| 表头 | B |\n| --- | --- |\n| 数据 | C |\n\n```js\nconst value = 1;\n```\n\n---\n\n最后一段。\n';
await fs.writeFile(file, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_DISCARD: 'discard', MEKI_TEST_SAVE_PATH: file };
delete env.ELECTRON_RUN_AS_NODE;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const handle = '.milkdown-block-handle:has(.operation-item)', paragraphs = [1, 2, 3].map(n => `.ProseMirror > p:nth-of-type(${n})`);
const results = [], errors = [], samples = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function frames(count = 2) { await page.evaluate(count => new Promise(resolve => { function tick() { if (--count <= 0) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }), count); }
async function geometry(selector) {
  return page.locator(selector).evaluate(node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) if (text.textContent.trim() && !text.parentElement.closest('svg,button,[contenteditable="false"]')) break;
    const range = document.createRange(); range.setStart(text, text.textContent.search(/\S/)); range.setEnd(text, text.textContent.search(/\S/) + 1);
    const line = range.getBoundingClientRect(), rect = node.getBoundingClientRect(), editor = document.querySelector('.ProseMirror').getBoundingClientRect();
    return { x: editor.left + 30, y: (line.top + line.bottom) / 2, top: rect.top, bottom: rect.bottom, gutter: editor.left - 18 };
  });
}
async function aligned(selector, gutter = false) {
  const expected = await geometry(selector); await page.mouse.move(gutter ? expected.gutter : expected.x, expected.y); await frames();
  const actual = await page.locator(handle).evaluate(node => { const r = node.getBoundingClientRect(); return { y: (r.top + r.bottom) / 2, show: node.dataset.show }; });
  const error = Math.abs(actual.y - expected.y); samples.push({ selector, gutter, error });
  assert.equal(actual.show, 'true'); assert.ok(error < 2, `handle must align within two animation frames: ${JSON.stringify({ expected, actual, error })}`);
}
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1200, 1000); window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]'); await page.waitForFunction(() => document.hasFocus());
  await page.evaluate(() => document.fonts.ready); await frames();
  await aligned(paragraphs[0]);
  await page.evaluate(() => { window.blockDragEvents = []; for (const type of ['dragstart','drop','dragend']) document.addEventListener(type, event => window.blockDragEvents.push({ type, types: [...(event.dataTransfer?.types || [])] }), true); });
  for (const selector of [...paragraphs, ...paragraphs.toReversed(), ...paragraphs]) await aligned(selector);
  pass('rapid pointer movement follows each paragraph within two frames without positional lag');
  for (const selector of paragraphs) await aligned(selector, true);
  const before = await geometry(paragraphs[0]), after = await geometry(paragraphs[1]);
  await page.mouse.move(before.gutter, (before.bottom + after.top) / 2); await frames();
  assert.equal(await page.locator(handle).getAttribute('data-show'), 'true');
  pass('left gutter and paragraph margins keep controls visible and track the intended block');
  await aligned(paragraphs[0]);
  const scrollFrom = await geometry(paragraphs[0]), scrollTo = await geometry(paragraphs[1]);
  await page.locator('.document-scroll').evaluate((node, amount) => { node.scrollTop += amount; }, scrollTo.y - scrollFrom.y);
  await frames(3);
  const scrolledLine = await geometry(paragraphs[1]), scrolledHandle = await page.locator(handle).boundingBox();
  assert.ok(Math.abs(scrolledHandle.y + scrolledHandle.height / 2 - scrolledLine.y) < 2);
  pass('scrolling recalculates the hovered block even while the pointer stays still');
  await aligned('.ProseMirror > h2');
  await page.locator('.ProseMirror > p:nth-of-type(4)').scrollIntoViewIfNeeded(); await aligned('.ProseMirror > p:nth-of-type(4)');
  await page.screenshot({ path: path.join(run, 'first-line.png') });
  pass('wrapped headings and multi-line paragraphs align controls with their first text line');
  for (const selector of ['.ProseMirror li:has-text("清单第二项") p', '.ProseMirror blockquote p:first-child', '.ProseMirror tr:first-child th:first-child p']) {
    await page.locator(selector).first().scrollIntoViewIfNeeded(); await aligned(selector);
  }
  await page.emulateMedia({ media: 'print' }); assert.equal(await page.locator(handle).isVisible(), false); await page.emulateMedia({ media: 'screen' });
  pass('list items, quotes and table headers align correctly; controls stay out of print output');
  for (const size of [14, 24, 18]) {
    await action('style'); await page.locator('#font-size').fill(String(size)); await action('style');
    await page.locator(paragraphs[1]).scrollIntoViewIfNeeded(); await aligned(paragraphs[1]);
  }
  pass('typography size changes keep controls aligned without fixed pixel offsets');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 760)); await frames();
  await page.locator(paragraphs[1]).scrollIntoViewIfNeeded(); await aligned(paragraphs[1]);
  const visible = await page.locator(handle).evaluate(node => { const r = node.getBoundingClientRect(), parent = document.querySelector('.document-scroll').getBoundingClientRect(); return r.left >= parent.left && r.right <= document.querySelector('.ProseMirror').getBoundingClientRect().left; });
  assert.equal(visible, true); await page.screenshot({ path: path.join(run, 'narrow.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await aligned(paragraphs[2]);
  assert.equal(await page.locator(handle).evaluate(node => getComputedStyle(node).transitionDuration), '0s');
  pass('narrow windows reserve a usable gutter and reduced-motion preference is respected');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await page.locator(paragraphs[1]).scrollIntoViewIfNeeded(); await aligned(paragraphs[1]);
  await page.locator(`${handle} .operation-item`).first().click();
  await page.locator('.milkdown-slash-menu[data-show="true"]').waitFor();
  await frames(3);
  assert.equal(await page.locator('.milkdown-slash-menu').evaluate(node => { const menu = node.getBoundingClientRect(), viewport = document.querySelector('.document-scroll').getBoundingClientRect(); return menu.top >= viewport.top && menu.bottom <= viewport.bottom; }), true, 'insert menu must fit inside the writing viewport');
  await page.locator('.milkdown-slash-menu').getByText('正文', { exact: true }).click();
  await page.keyboard.insertText('Inserted after Beta');
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].map(p => p.textContent).join('|').includes('Beta 第二段。|Inserted after Beta|Gamma 第三段。'));
  await page.keyboard.press(`${modifier}+z`); await page.keyboard.press(`${modifier}+z`);
  // Reload the untouched fixture for a drag test independent of menu undo grouping.
  await action('reload-document'); await page.waitForFunction(() => !document.querySelector('.ProseMirror').textContent.includes('Inserted after Beta'));
  pass('plus inserts at the displayed paragraph and retains editable slash-menu behavior');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 1000)); await frames();
  await page.locator(paragraphs[0]).scrollIntoViewIfNeeded();
  await aligned(paragraphs[0]);
  const drag = await page.locator(`${handle} .operation-item`).last().boundingBox();
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2); await page.mouse.down();
  await frames();
  const target = await geometry(paragraphs[2]);
  await page.mouse.move(drag.x + drag.width + 15, drag.y + drag.height / 2, { steps: 5 });
  await page.mouse.move(target.x, target.bottom + 5, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].slice(0, 3).map(p => p.textContent).join('|') === 'Beta 第二段。|Gamma 第三段。|Alpha 第一段。');
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].slice(0, 3).map(p => p.textContent).join('|') === 'Alpha 第一段。|Beta 第二段。|Gamma 第三段。');
  pass('drag moves the displayed block exactly once and undo restores the original order');
  await aligned(paragraphs[0]);
  const cancelHandle = await page.locator(`${handle} .operation-item`).last().boundingBox();
  await page.mouse.move(cancelHandle.x + 12, cancelHandle.y + 12); await page.mouse.down();
  await page.mouse.move(cancelHandle.x + 80, cancelHandle.y + 20, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.ProseMirror').dataset.dragging !== 'true');
  assert.deepEqual(await page.locator('.ProseMirror > p').allTextContents().then(items => items.slice(0, 3)), ['Alpha 第一段。', 'Beta 第二段。', 'Gamma 第三段。']);
  pass('cancelling a native drag preserves the document and releases drag state');

  await aligned(paragraphs[1]); await page.mouse.move(10, 10); await frames(); assert.equal(await page.locator(handle).getAttribute('data-show'), 'false');
  await page.locator('[data-mode="source"]').click(); assert.equal(await page.locator(handle).isVisible(), false);
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.deepEqual(errors, []);
  pass('leaving the editor and source mode hide controls; hover does not change disk content');
} finally {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); await fs.writeFile(path.join(run, 'drag-events.json'), JSON.stringify(await page.evaluate(() => window.blockDragEvents || []).catch(() => []), null, 2)); }
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, samples }, null, 2)); console.log(`Evidence: ${run}`);
}

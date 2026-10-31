import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'block-actions-'))), profile = path.join(run, 'profile');
await fs.mkdir(profile);
await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { locale: 'en', autoSave: false, autoSnapshot: false } }));
const file = path.join(run, 'Blocks.md'), second = path.join(run, 'Other.md');
const original = '\uFEFF' + ('# Block actions\n\nAlpha **bold** text.\n\nBeta plain text.\n\nGamma plain text.\n\n- [x] Task done\n  - Nested child\n- [ ] Task todo\n\n| Column | Value |\n| --- | --- |\n| Cell | 42 |\n\n```js\nconst answer = 42;\n```\n\n---\n\nLong block: ' + 'Keep every word and show a compact preview. '.repeat(220) + '\n\n' + Array.from({ length: 70 }, (_, i) => `Scroll paragraph ${i + 1}.`).join('\n\n') + '\n').replaceAll('\n', '\r\n');
await fs.writeFile(file, original); await fs.writeFile(second, '# Other document\n\nUntouched second document.\n');
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const results = [], errors = []; let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
const paragraph = text => page.locator('.ProseMirror p').filter({ hasText: new RegExp('^' + text) }).first();
const menuRoot = () => page.locator('.moye-block-menu:not(.moye-block-submenu)');
const row = id => page.locator(`[data-block-action="${id}"]`);
async function frames(count = 3) { await page.evaluate(count => new Promise(resolve => { function tick() { if (--count <= 0) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }), count); }
async function hover(block) {
  await block.scrollIntoViewIfNeeded();
  await block.evaluate(element => { const scroll = element.closest('.document-scroll'); const rect = element.getBoundingClientRect(); if (rect.height > scroll.clientHeight / 2) scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - 24; });
  await frames();
  const point = await block.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) if (text.textContent.trim() && !text.parentElement.closest('button,svg')) break;
    const range = document.createRange(); range.setStart(text, text.textContent.search(/\S/)); range.setEnd(text, text.textContent.search(/\S/) + 1);
    const rect = range.getBoundingClientRect(); return { x: rect.left + 3, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.move(point.x, point.y); await frames();
  return page.locator('.milkdown-block-handle[data-show="true"] .operation-item').last();
}
async function menu(block) {
  const grip = await (await hover(block)).boundingBox();
  // Use the same actual gutter pointer coordinates for clicking and dragging.
  await page.mouse.click(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await menuRoot().waitFor();
}
async function undo() { await page.keyboard.press(`${mod}+z`); await frames(); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function reload() { await action('reload-document'); await page.waitForFunction(() => document.querySelector('.ProseMirror > p')?.textContent === 'Alpha bold text.'); }
async function dragStart(block, alt = false) {
  const grip = await (await hover(block)).boundingBox();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + 80, grip.y + 12, { steps: 6 });
  await page.locator('.moye-block-drag-preview').waitFor();
}
async function order() { return (await page.locator('.ProseMirror > p').allTextContents()).slice(0, 3).join('|'); }
try {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1200, 1000); win.show(); win.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]'); await page.waitForFunction(() => document.hasFocus()); await page.evaluate(() => document.fonts.ready);

  const alpha = paragraph('Alpha'), beta = paragraph('Beta'), gamma = paragraph('Gamma');
  const before = await alpha.boundingBox(); await menu(alpha);
  assert.doesNotMatch(await menuRoot().innerText(), /[\p{Script=Han}]/u);
  const after = await alpha.boundingBox(); assert.equal(before.y, after.y); assert.equal(before.height, after.height);
  const betaRect = await beta.boundingBox(); await page.mouse.move(betaRect.x + 20, betaRect.y + 10); await frames();
  assert.equal(await page.locator('.moye-block-menu-target').textContent(), 'Alpha bold text.');
  await page.screenshot({ path: path.join(run, 'menu.png') });
  await row('copy-markdown').click(); await page.waitForFunction(() => document.querySelector('.moye-block-menu-footer')?.textContent === 'Copied');
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /Alpha \*\*bold\*\* text/);
  await row('copy-text').click(); await page.waitForFunction(async () => (await window.moye.readClipboardText()) === 'Alpha bold text.');
  await page.keyboard.press('Escape'); await menuRoot().waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  pass('six-dot menu is pinned, localized, layout-neutral and copies the whole block without editing BOM/CRLF content');

  await menu(alpha); await menuRoot().locator('input').fill('Heading 2'); await page.keyboard.press('Enter');
  await page.locator('.ProseMirror > h2').filter({ hasText: 'Alpha bold text.' }).waitFor();
  assert.equal(await page.locator('.ProseMirror > h2 strong').textContent(), 'bold'); await undo(); await alpha.waitFor();
  pass('search and Enter convert a block, preserve inline formatting and undo in one step');

  await menu(beta); await row('style').click(); await row('style-strong').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p strong')].some(node => node.textContent === 'Beta plain text.'));
  await undo(); assert.equal(await beta.locator('strong').count(), 0);
  await menu(alpha); await row('duplicate').click(); await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].filter(node => node.textContent === 'Alpha bold text.').length === 2); await undo();
  await menu(gamma); await row('move').click(); await row('move-up').click();
  assert.equal(await order(), 'Alpha bold text.|Gamma plain text.|Beta plain text.'); await undo();
  pass('block styles, duplication and sibling moves target the chosen block and each undo separately');

  await menu(paragraph('Task done')); await row('copy-markdown').click();
  await page.waitForFunction(async () => /\[x\] Task done/.test(await window.moye.readClipboardText()));
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /Nested child/);
  await row('convert').click(); await row('convert-h3').click();
  await page.locator('.ProseMirror > h3').filter({ hasText: 'Task done' }).waitFor(); await paragraph('Nested child').waitFor(); await paragraph('Task todo').waitFor();
  await undo(); await menu(paragraph('Task todo')); await row('list').click(); await row('indent').click();
  await menuRoot().waitFor({ state: 'detached' }); await undo();
  pass('task copy, heading conversion and indentation retain nested content and checkbox state');

  await menu(beta); await row('insert').click(); await row('insert-after').click(); await page.keyboard.insertText('Inserted block');
  await paragraph('Inserted block').waitFor(); await undo(); await undo(); assert.equal(await paragraph('Inserted block').count(), 0);
  await menu(beta); await row('delete').click(); await beta.waitFor({ state: 'detached' }); await undo(); await beta.waitFor();
  pass('insert and delete work on whole blocks with predictable undo boundaries');

  await menu(alpha); await menuRoot().locator('input').fill('nothing-matches'); assert.equal(await menuRoot().locator('button').count(), 0);
  await menuRoot().locator('input').fill(''); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await page.locator('.moye-block-submenu').waitFor(); await page.waitForFunction(() => document.activeElement?.closest('.moye-block-submenu'));
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.moye-block-submenu').count(), 0);
  await page.keyboard.press('Escape'); assert.equal(await menuRoot().count(), 0);
  const keyboardGrip = await hover(alpha); await keyboardGrip.focus(); await page.keyboard.press('Enter'); await menuRoot().waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.moye-block-menu input')); await page.keyboard.press('Escape');
  await menu(alpha); await page.emulateMedia({ media: 'print' }); assert.equal(await menuRoot().isVisible(), false); await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 760)); await menu(alpha); await row('convert').click(); await frames();
  for (const box of await page.locator('.moye-block-menu').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; }))) {
    assert.ok(box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height, JSON.stringify(box));
  }
  await page.screenshot({ path: path.join(run, 'narrow-submenu.png') }); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 1000));
  pass('menus support keyboard navigation, empty search, viewport fitting and clean print output');

  await reload(); await alpha.scrollIntoViewIfNeeded(); const destination = await beta.boundingBox();
  await dragStart(gamma); await page.mouse.move(destination.x + 50, destination.y + destination.height * .25, { steps: 12 });
  await page.locator('.moye-block-drop-line').waitFor({ state: 'visible' });
  const line = await page.locator('.moye-block-drop-line').boundingBox(); assert.ok(line.y < destination.y + 3);
  await page.screenshot({ path: path.join(run, 'drag-boundary.png') }); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].slice(0, 3).map(node => node.textContent).join('|') === 'Alpha bold text.|Gamma plain text.|Beta plain text.');
  await undo(); assert.equal(await order(), 'Alpha bold text.|Beta plain text.|Gamma plain text.');
  pass('native mouse dragging snaps to block boundaries, shows an insertion line and never splits the target text');

  await dragStart(alpha, true); const copyTarget = await gamma.boundingBox(); await page.mouse.move(copyTarget.x + 40, copyTarget.y + copyTarget.height - 1, { steps: 12 });
  await page.waitForFunction(() => document.querySelector('.moye-block-drag-preview')?.dataset.copy === 'true');
  await page.mouse.up(); await page.keyboard.up('Alt');
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].filter(node => node.textContent === 'Alpha bold text.').length === 2); await undo();
  pass('Alt/Option dragging copies the block while retaining its source and undo removes only the copy');

  // Hosted macOS displays can clamp the window height. Keep the destination's
  // insertion line inside the viewport before testing a nested task move.
  await paragraph('Task todo').evaluate(node => node.scrollIntoView({ block: 'center' })); await frames();
  await dragStart(paragraph('Task done')); const todo = await paragraph('Task todo').boundingBox();
  await page.mouse.move(todo.x + 40, todo.y + todo.height - 2, { steps: 12 });
  await page.locator('.moye-block-drop-line').waitFor({ state: 'visible' }); await page.mouse.up();
  await page.waitForFunction(() => { const text = document.querySelector('.ProseMirror').textContent; return text.indexOf('Task todo') < text.indexOf('Task done'); });
  await paragraph('Nested child').waitFor(); await undo();
  pass('native dragging reorders a task with its nested list instead of extracting or flattening its contents');

  const long = paragraph('Long block:'); await dragStart(long);
  assert.ok((await page.locator('.moye-block-drag-preview').boundingBox()).height < 100);
  const viewport = await page.locator('.document-scroll').boundingBox(), startScroll = await page.locator('.document-scroll').evaluate(node => node.scrollTop);
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height - 8, { steps: 10 });
  await page.waitForFunction(start => document.querySelector('.document-scroll').scrollTop > start + 350, startScroll);
  await page.screenshot({ path: path.join(run, 'edge-scroll.png') }); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.locator('.moye-block-drag-preview').waitFor({ state: 'detached' });
  const stoppedAt = await page.locator('.document-scroll').evaluate(node => node.scrollTop); await frames(12);
  assert.ok(Math.abs(await page.locator('.document-scroll').evaluate(node => node.scrollTop) - stoppedAt) < 2, 'cancelling must stop both native and application autoscroll');
  assert.equal(await long.textContent(), 'Long block: ' + 'Keep every word and show a compact preview. '.repeat(220).trimEnd());
  pass('large blocks use compact previews and continuous edge scrolling works with a stationary pointer; Escape leaves content intact');

  await menu(alpha); await page.locator('[data-mode="source"]').click(); assert.equal(await menuRoot().count(), 0);
  await page.locator('[data-mode="visual"]').click(); await menu(alpha);
  await app.evaluate((_electron, file) => { process.env.MOYE_TEST_OPEN_PATH = file; }, second); await action('open');
  await page.locator('.ProseMirror h1').filter({ hasText: 'Other document' }).waitFor(); assert.equal(await menuRoot().count(), 0);
  assert.equal(await page.locator('.moye-block-menu-target').count(), 0);
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.deepEqual(errors, []);
  pass('mode and document switches discard captured actions, clear block highlighting and leave disk files untouched');

  const tab = await page.getByRole('tab', { name: /Other\.md/ }).boundingBox(), body = await page.locator('.pane-body').boundingBox();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2); await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2 + 15, { steps: 4 });
  await page.mouse.move(body.x + body.width - 15, body.y + body.height / 2, { steps: 15 });
  await page.locator('.pane-drop-preview').waitFor(); await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 2 && !document.body.classList.contains('is-busy'));
  await dragStart(alpha); const other = await paragraph('Untouched second').boundingBox();
  await page.mouse.move(other.x + 20, other.y + 8, { steps: 15 }); await frames();
  assert.equal(await page.locator('.moye-block-drop-line').isVisible(), false); await page.mouse.up();
  assert.equal(await page.locator('.editor-pane').nth(1).locator('.ProseMirror > p').textContent(), 'Untouched second document.');
  assert.equal(await page.locator('.editor-pane').nth(0).locator('.ProseMirror > p').first().textContent(), 'Alpha bold text.');
  assert.equal(await page.locator('.moye-block-drag-preview').count(), 0); assert.deepEqual(errors, []);
  pass('dropping a block into another document pane is rejected without removing or inserting content');
} finally {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); }
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

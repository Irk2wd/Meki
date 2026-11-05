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
const original = '\uFEFF' + ('# Block actions\n\nAlpha **bold** text.\n\nBeta plain text.\n\nGamma plain text.\n\n- [x] Task done\n  - Nested child\n- [ ] Task todo\n\n| Column | Value |\n| --- | --- |\n| Cell | 42 |\n\n```js\nconst answer = 42;\n```\n\n```mermaid\nflowchart LR\n A[Write] --> B[Arrange]\n```\n\n$$\nE=mc^2\n$$\n\n---\n\nLong block: ' + 'Keep every word and show a compact preview. '.repeat(220) + '\n\n' + Array.from({ length: 70 }, (_, i) => `Scroll paragraph ${i + 1}.`).join('\n\n') + '\n').replaceAll('\n', '\r\n');
await fs.writeFile(file, original); await fs.writeFile(second, '# Other document\n\nUntouched second document.\n');
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const results = [], errors = []; let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function opacitySamples(selector, action) {
  await page.evaluate(selector => {
    window.blockFadeFrames = new Promise(resolve => {
      const samples = [], start = performance.now();
      const record = () => {
        const node = document.querySelector(selector);
        samples.push(node && !node.hidden ? Number(getComputedStyle(node).opacity) : 0);
        if (performance.now() - start < 280) requestAnimationFrame(record); else resolve(samples);
      };
      requestAnimationFrame(record);
    });
  }, selector);
  await action(); return page.evaluate(() => window.blockFadeFrames);
}
const paragraph = text => page.locator('.ProseMirror p').filter({ hasText: new RegExp('^' + text) }).first();
const menuRoot = () => page.locator('.meki-block-menu:not(.meki-block-submenu)');
const row = id => page.locator(`[data-block-action="${id}"]`);
async function frames(count = 3) { await page.evaluate(count => new Promise(resolve => { function tick() { if (--count <= 0) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }), count); }
async function hover(block) {
  await block.scrollIntoViewIfNeeded();
  await block.evaluate(element => { const scroll = element.closest('.document-scroll'); const rect = element.getBoundingClientRect(); if (rect.height > scroll.clientHeight / 2) scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - 24; });
  await frames();
  const point = await block.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) {
      const start = text.textContent.search(/\S/);
      if (start < 0 || text.parentElement.closest('button,svg')) continue;
      const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 1);
      const rect = range.getBoundingClientRect();
      if (rect.height) return { x: rect.left + 3, y: (rect.top + rect.bottom) / 2 };
    }
    const rect = element.getBoundingClientRect(); return { x: rect.left + 30, y: rect.top + Math.min(20, rect.height / 2) };
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
  await page.locator('.meki-block-drag-preview').waitFor();
}
async function order() { return (await page.locator('.ProseMirror > p').allTextContents()).slice(0, 3).join('|'); }
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1200, 1000); win.show(); win.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]'); await page.waitForFunction(() => document.hasFocus()); await page.evaluate(() => document.fonts.ready);

  const alpha = paragraph('Alpha'), beta = paragraph('Beta'), gamma = paragraph('Gamma');
  const before = await alpha.boundingBox(); await menu(alpha);
  assert.doesNotMatch(await menuRoot().innerText(), /[\p{Script=Han}]/u);
  const after = await alpha.boundingBox(); assert.equal(before.y, after.y); assert.equal(before.height, after.height);
  const betaRect = await beta.boundingBox(); await page.mouse.move(betaRect.x + 20, betaRect.y + 10); await frames();
  assert.equal(await page.locator('.meki-block-menu-target').textContent(), 'Alpha bold text.');
  await page.screenshot({ path: path.join(run, 'menu.png') });
  await row('copy-markdown').click(); await page.waitForFunction(() => document.querySelector('.meki-block-menu-footer')?.textContent === 'Copied');
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /Alpha \*\*bold\*\* text/);
  await row('copy-text').click(); await page.waitForFunction(async () => (await window.meki.readClipboardText()) === 'Alpha bold text.');
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
  await page.waitForFunction(async () => /\[x\] Task done/.test(await window.meki.readClipboardText()));
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
  await page.locator('.meki-block-submenu').waitFor(); await page.waitForFunction(() => document.activeElement?.closest('.meki-block-submenu'));
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.meki-block-submenu').count(), 0);
  await page.keyboard.press('Escape'); assert.equal(await menuRoot().count(), 0);
  const keyboardGrip = await hover(alpha); await keyboardGrip.focus(); await page.keyboard.press('Enter'); await menuRoot().waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.meki-block-menu input')); await page.keyboard.press('Escape');
  await menu(alpha); await page.emulateMedia({ media: 'print' }); assert.equal(await menuRoot().isVisible(), false); await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 760)); await menu(alpha); await row('convert').click(); await frames();
  for (const box of await page.locator('.meki-block-menu').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; }))) {
    assert.ok(box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height, JSON.stringify(box));
  }
  await page.screenshot({ path: path.join(run, 'narrow-submenu.png') }); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 1000));
  pass('menus support keyboard navigation, empty search, viewport fitting and clean print output');

  await reload();
  const clickGrip = await (await hover(alpha)).boundingBox();
  await page.mouse.move(clickGrip.x + clickGrip.width / 2, clickGrip.y + clickGrip.height / 2); await page.mouse.down();
  await page.mouse.move(clickGrip.x + clickGrip.width / 2 + 2, clickGrip.y + clickGrip.height / 2 + 1);
  assert.equal(await page.locator('.meki-block-drag-preview').count(), 0);
  await page.mouse.up(); await menuRoot().waitFor(); await page.keyboard.press('Escape');
  assert.equal(await order(), 'Alpha bold text.|Beta plain text.|Gamma plain text.');
  pass('a small pointer tremor opens the block menu without starting a drag or changing content');

  await dragStart(alpha);
  assert.equal(await page.locator('.meki-block-drag-content strong').textContent(), 'bold');
  const follow = await beta.boundingBox(), pointer = { x: follow.x + 50, y: follow.y + follow.height * .75 };
  await page.mouse.move(pointer.x, pointer.y); await frames();
  const preview = await page.locator('.meki-block-drag-preview').boundingBox();
  assert.ok(Math.abs(preview.x - pointer.x - 18) < 2 && Math.abs(preview.y - pointer.y - 16) < 2);
  assert.equal(await page.locator('.meki-block-drag-preview [contenteditable]').count(), 0);
  await page.keyboard.down('Alt'); await frames();
  assert.equal(await page.locator('.meki-block-drag-preview').getAttribute('data-copy'), 'true');
  assert.equal(await page.locator('.meki-block-drag-copy').isVisible(), true);
  await page.keyboard.up('Alt'); await frames();
  assert.equal(await page.locator('.meki-block-drag-preview').getAttribute('data-copy'), 'false');
  await page.screenshot({ path: path.join(run, 'formatted-drag-preview.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.meki-block-drag-preview').count(), 0);
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('meki-block-dragging')), false);
  pass('drag previews preserve rich text, follow the pointer within a frame and reflect Option changes without pointer movement');

  await dragStart(gamma); const first = await alpha.boundingBox(), midpoint = first.y + first.height / 2;
  const lineEntering = await opacitySamples('.meki-block-drop-line', () => page.mouse.move(first.x + 60, midpoint - 9));
  assert.ok(lineEntering.some(value => value > 0 && value < 1) && lineEntering.at(-1) === 1);
  const snapped = await page.locator('.meki-block-drop-line').boundingBox();
  for (const delta of [-1, 1, -2, 2]) {
    await page.mouse.move(first.x + 60, midpoint + delta); await frames();
    assert.ok(Math.abs((await page.locator('.meki-block-drop-line').boundingBox()).y - snapped.y) < 1);
  }
  const lineChanging = await opacitySamples('.meki-block-drop-line', () => page.mouse.move(first.x + 60, midpoint + 9));
  assert.ok(lineChanging.some(value => value > 0 && value < 1) && lineChanging.at(-1) === 1);
  assert.ok((await page.locator('.meki-block-drop-line').boundingBox()).y > snapped.y + first.height);
  const lineLeaving = await opacitySamples('.meki-block-drop-leaving', async () => { await page.keyboard.press('Escape'); await page.mouse.up(); });
  assert.ok(lineLeaving.some(value => value > 0 && value < 1) && lineLeaving.at(-1) === 0);
  assert.equal(await order(), 'Alpha bold text.|Beta plain text.|Gamma plain text.');
  pass('insertion guides fade at new destinations, resist midpoint jitter and fade out on cancellation');

  await menu(alpha);
  const openGrip = await page.locator('.milkdown-block-handle[data-show="true"] .operation-item').last().boundingBox();
  await page.mouse.move(openGrip.x + openGrip.width / 2, openGrip.y + openGrip.height / 2); await page.mouse.down();
  await page.mouse.move(openGrip.x + 70, openGrip.y + 12, { steps: 4 });
  await page.locator('.meki-block-drag-preview').waitFor();
  assert.equal(await menuRoot().count(), 0);
  await page.keyboard.press('Escape'); await page.mouse.up();
  pass('dragging from an open block menu dismisses the menu and cancellation leaves the block intact');

  for (const theme of ['linen', 'night']) {
    await action('style'); await page.locator(`button[data-theme="${theme}"]`).click(); await action('style');
    await dragStart(alpha); const target = await beta.boundingBox();
    await page.mouse.move(target.x + 60, target.y + target.height * .75); await frames();
    assert.equal(await page.locator('.meki-block-drag-preview').evaluate(node => getComputedStyle(node).backgroundColor),
      await page.locator('.editor.ProseMirror').evaluate(node => getComputedStyle(node).backgroundColor));
    assert.equal(await page.locator('.meki-block-drop-line').isVisible(), true);
    await page.screenshot({ path: path.join(run, `drag-${theme}.png`) });
    await page.keyboard.press('Escape'); await page.mouse.up();
  }
  await action('style'); await page.locator('button[data-theme="paper"]').click(); await action('style');
  for (const [block, selector, text] of [
    [page.locator('.ProseMirror table.children').first(), 'table', 'Cell'],
    [page.locator('.milkdown-code-block').first(), '.cm-line', 'const answer = 42;'],
  ]) {
    await dragStart(block);
    assert.ok((await page.locator(`.meki-block-drag-content ${selector}`).innerText()).includes(text));
    assert.ok((await page.locator('.meki-block-drag-preview').boundingBox()).height < 100);
    await page.screenshot({ path: path.join(run, `preview-${selector === 'table' ? 'table' : 'code'}.png`) });
    await page.keyboard.press('Escape'); await page.mouse.up();
  }
  pass('previews retain the document theme, table cells and code content without overflowing');

  for (const selector of ['.meki-block-diagram', '.meki-block-math']) {
    const block = page.locator('.editor.ProseMirror .milkdown-code-block').filter({ has: page.locator(selector) }).first();
    await block.scrollIntoViewIfNeeded(); await block.locator(`${selector} svg`).first().waitFor(); await dragStart(block);
    const svg = page.locator('.meki-block-drag-preview svg').first(); assert.equal(await svg.isVisible(), true);
    const references = await page.locator('.meki-block-drag-preview').evaluate(preview => {
      const ids = [...preview.querySelectorAll('[id]')].map(node => node.id);
      const references = [...preview.querySelectorAll('*')].flatMap(node => [...node.attributes].flatMap(attribute => [...attribute.value.matchAll(/url\(["']?#([^)'"\s]+)/g)].map(match => match[1])));
      return { unique: ids.every(id => !document.querySelector('.editor.ProseMirror').querySelector(`[id="${id}"]`)),
        resolved: references.every(id => ids.includes(id)), markers: preview.querySelectorAll('marker').length };
    });
    assert.equal(references.unique, true); assert.equal(references.resolved, true);
    assert.equal(await page.locator('.meki-block-drag-preview').getAttribute('data-truncated'), 'false');
    if (selector === '.meki-block-diagram') assert.ok(references.markers > 0);
    await page.screenshot({ path: path.join(run, selector === '.meki-block-diagram' ? 'preview-diagram.png' : 'preview-equation.png') });
    await page.keyboard.press('Escape'); await page.mouse.up();
  }
  pass('diagram and equation handles ignore hidden source editors; preview SVG references remain valid and isolated');

  await reload(); await alpha.scrollIntoViewIfNeeded(); const destination = await beta.boundingBox();
  await dragStart(gamma); await page.mouse.move(destination.x + 50, destination.y + destination.height * .25, { steps: 12 });
  await page.locator('.meki-block-drop-line').waitFor({ state: 'visible' });
  const line = await page.locator('.meki-block-drop-line').boundingBox(); assert.ok(line.y < destination.y + 3);
  await page.screenshot({ path: path.join(run, 'drag-boundary.png') }); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].slice(0, 3).map(node => node.textContent).join('|') === 'Alpha bold text.|Gamma plain text.|Beta plain text.');
  await undo(); assert.equal(await order(), 'Alpha bold text.|Beta plain text.|Gamma plain text.');
  pass('pointer dragging snaps to block boundaries, shows an insertion line and never splits the target text');

  await dragStart(alpha, true); const copyTarget = await gamma.boundingBox(); await page.mouse.move(copyTarget.x + 40, copyTarget.y + copyTarget.height - 1, { steps: 12 });
  await page.waitForFunction(() => document.querySelector('.meki-block-drag-preview')?.dataset.copy === 'true');
  await page.mouse.up(); await page.keyboard.up('Alt');
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].filter(node => node.textContent === 'Alpha bold text.').length === 2); await undo();
  pass('Alt/Option dragging copies the block while retaining its source and undo removes only the copy');

  // Hosted macOS displays can clamp the window height. Keep the destination's
  // insertion line inside the viewport before testing a nested task move.
  await paragraph('Task todo').evaluate(node => node.scrollIntoView({ block: 'center' })); await frames();
  await dragStart(paragraph('Task done')); const todo = await paragraph('Task todo').boundingBox();
  await page.mouse.move(todo.x + 40, todo.y + todo.height - 2, { steps: 12 });
  await page.locator('.meki-block-drop-line').waitFor({ state: 'visible' }); await page.mouse.up();
  await page.waitForFunction(() => { const text = document.querySelector('.ProseMirror').textContent; return text.indexOf('Task todo') < text.indexOf('Task done'); });
  await paragraph('Nested child').waitFor(); await undo();
  pass('pointer dragging reorders a task with its nested list instead of extracting or flattening its contents');

  const long = paragraph('Long block:'); await dragStart(long);
  assert.ok((await page.locator('.meki-block-drag-preview').boundingBox()).height < 100);
  const viewport = await page.locator('.document-scroll').boundingBox(), startScroll = await page.locator('.document-scroll').evaluate(node => node.scrollTop);
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height - 8, { steps: 10 });
  await page.waitForFunction(start => document.querySelector('.document-scroll').scrollTop > start + 350, startScroll);
  await page.screenshot({ path: path.join(run, 'edge-scroll.png') }); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.locator('.meki-block-drag-preview').waitFor({ state: 'detached' });
  const stoppedAt = await page.locator('.document-scroll').evaluate(node => node.scrollTop); await frames(12);
  assert.ok(Math.abs(await page.locator('.document-scroll').evaluate(node => node.scrollTop) - stoppedAt) < 2, 'cancelling must stop both native and application autoscroll');
  assert.equal(await long.textContent(), 'Long block: ' + 'Keep every word and show a compact preview. '.repeat(220).trimEnd());
  pass('large blocks use compact previews and continuous edge scrolling works with a stationary pointer; Escape leaves content intact');

  await menu(alpha); await page.locator('[data-mode="source"]').click(); assert.equal(await menuRoot().count(), 0);
  await page.locator('[data-mode="visual"]').click(); await menu(alpha);
  await app.evaluate((_electron, file) => { process.env.MEKI_TEST_OPEN_PATH = file; }, second); await action('open');
  await page.locator('.ProseMirror h1').filter({ hasText: 'Other document' }).waitFor(); assert.equal(await menuRoot().count(), 0);
  assert.equal(await page.locator('.meki-block-menu-target').count(), 0);
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
  assert.equal(await page.locator('.meki-block-drop-line').isVisible(), false); await page.mouse.up();
  assert.equal(await page.locator('.editor-pane').nth(1).locator('.ProseMirror > p').textContent(), 'Untouched second document.');
  assert.equal(await page.locator('.editor-pane').nth(0).locator('.ProseMirror > p').first().textContent(), 'Alpha bold text.');
  assert.equal(await page.locator('.meki-block-drag-preview').count(), 0); assert.deepEqual(errors, []);
  pass('dropping a block into another document pane is rejected without removing or inserting content');
} finally {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); }
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

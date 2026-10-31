import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'panes-'))), profile = path.join(run, 'profile');
const files = Object.fromEntries(['Alpha', 'Beta', 'Gamma', 'Delta', 'Extra'].map(name => [name, path.join(run, `${name}.md`)]));
for (const [name, file] of Object.entries(files)) await fs.writeFile(file, `\uFEFF# ${name}\r\n\r\n${name} original $x+1$.\r\n`);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'cancel' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
let app, page; const results = [], errors = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function poll(check, description) { const limit = Date.now() + 20000; while (Date.now() < limit) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw Error(`Timed out: ${description}`); }
async function session() { return JSON.parse(await fs.readFile(path.join(profile, 'windows-v1.json'), 'utf8')).windows[0].session; }
async function setting(name, value) { await app.evaluate((_electron, { name, value }) => { process.env[name] = value; }, { name, value }); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function focus() { await (await app.browserWindow(page)).evaluate(win => { win.show(); win.focus(); }); await page.waitForFunction(() => document.hasFocus()); }
async function launch() {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', files.Alpha] : [root, '--open', files.Alpha], env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#shell[data-ready="true"]'); await focus();
  await page.evaluate(() => {
    globalThis.paneKeyTrace = [];
    window.addEventListener('keydown', event => {
      const record = { key: event.key, target: event.target.className, focused: document.hasFocus(), busy: document.body.classList.contains('is-busy'), ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey };
      globalThis.paneKeyTrace.push(record); if (globalThis.paneKeyTrace.length > 30) globalThis.paneKeyTrace.shift();
      setTimeout(() => { record.prevented = event.defaultPrevented; record.focusAfter = document.activeElement?.className; record.ratio = document.querySelector('.pane-divider')?.getAttribute('aria-valuenow'); }, 0);
    }, true);
  });
}
async function stop() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function action(name) { await idle(); await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); }
// Keep each predicate based on a single persisted session snapshot.
async function openFile(name) { await setting('MOYE_TEST_OPEN_PATH', files[name]); await action('open'); await poll(async () => { const state = await session(); return state.documents.find(doc => doc.id === state.activeId)?.path === files[name]; }, 'open file'); await idle(); }
const tabs = name => page.locator(`[role="tab"][title="${files[name].replaceAll('\\', '\\\\')}"]:visible`);
async function source() { await focus(); await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content'); }
async function append(value) { const field = await source(); await field.click(); await page.keyboard.press(end); await page.keyboard.insertText(value); await poll(async () => (await session()).documents.some(doc => doc.content.includes(value)), 'buffer persisted'); }
async function drag(name, destination, check = true) {
  await idle(); await focus(); const tab = await tabs(name).boundingBox(); assert.ok(tab);
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2); await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2 + 12, { steps: 3 });
  await page.mouse.move(destination.x, destination.y, { steps: 15 });
  if (check) await page.locator('.pane-drop-preview').waitFor({ state: 'visible' });
}
async function bodyPoint(pane, edge) { const box = await pane.locator('.pane-body').boundingBox(); return { x: box.x + box.width * (edge === 'right' ? .94 : edge === 'left' ? .06 : .5), y: box.y + box.height * (edge === 'bottom' ? .94 : edge === 'top' ? .06 : .5) }; }
async function split(name, pane, edge, count) { await drag(name, await bodyPoint(pane, edge)); await page.mouse.up(); await poll(async () => await page.locator('.editor-pane').count() === count && !await page.locator('body').evaluate(node => node.classList.contains('is-busy')), 'split committed'); }
try {
  await launch(); await openFile('Beta'); await append('\nDirty Beta');
  const firstTab = await tabs('Alpha').boundingBox();
  await drag('Beta', { x: firstTab.x + 3, y: firstTab.y + firstTab.height / 2 }); await page.mouse.up(); await idle();
  assert.match(await page.locator('.document-tab-list [role="tab"]').first().textContent(), /Beta/);
  pass('dragging within the single-pane tab strip visibly reorders documents without splitting or changing their contents');
  const beta = (await session()).documents.find(doc => doc.path === files.Beta);
  await split('Beta', page.locator('.editor-pane'), 'right', 2);
  await page.waitForFunction(() => document.activeElement?.closest('#source-editor'));
  assert.equal(app.windows().length, 1);
  assert.equal(await page.locator('.editor-pane').nth(0).locator('.ProseMirror h1').textContent(), 'Alpha');
  assert.ok(await page.locator('.editor-pane').nth(1).locator('.source-editor').isVisible());
  assert.equal((await session()).documents.find(doc => doc.path === files.Beta).id, beta.id);
  await focus(); await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+z`);
  await page.waitForFunction(() => !document.querySelector('#source-editor').textContent.includes('Dirty Beta'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'); await page.waitForFunction(() => document.querySelector('#source-editor').textContent.includes('Dirty Beta'));
  pass('dragging a dirty tab previews and creates two editable panes in one native window, preserving identity, mode and undo');

  const alphaPane = page.locator('.editor-pane').nth(0);
  await alphaPane.locator('.ProseMirror').click(); await page.keyboard.press(end); await page.keyboard.insertText(' Alpha edit');
  await page.keyboard.press(`${mod}+s`); await poll(async () => (await fs.readFile(files.Alpha, 'utf8')).includes('Alpha edit'), 'save targets focused pane');
  assert.equal(await fs.readFile(files.Beta, 'utf8'), '\uFEFF# Beta\r\n\r\nBeta original $x+1$.\r\n');
  await idle();
  await page.locator('.editor-pane').nth(1).locator('.cm-content').click();
  await action('find'); await page.locator('#find-query').fill('Dirty Beta'); await page.locator('#find-count').filter({ hasText: '1 / 1' }).waitFor(); await action('find-close');
  pass('focus routes typing, save shortcuts, mode and search to the correct pane without writing the other document');

  const divider = page.getByRole('separator', { name: '调整分栏大小' }), bounds = await page.locator('.editor-layout').boundingBox(), handle = await divider.boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 100); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .63, handle.y + 100, { steps: 12 }); await page.mouse.up();
  await poll(async () => (await session()).layout.ratio > .6, 'resize persists');
  await idle();
  const ratio = (await session()).layout.ratio;
  const moved = await divider.boundingBox(); await page.mouse.move(moved.x + 3, moved.y + 100); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .4, moved.y + 100, { steps: 8 }); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.ok(Math.abs(Number(await divider.getAttribute('aria-valuenow')) / 100 - ratio) < .02);
  await page.screenshot({ path: path.join(run, 'two-panes.png') });
  pass('the divider resizes continuously and persists its ratio; Escape cancels an unfinished resize');

  await drag('Beta', await bodyPoint(alphaPane, 'left')); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.editor-pane').count(), 2); assert.equal((await session()).layout.ratio, ratio);
  await stop(); await launch();
  assert.equal(await page.locator('.editor-pane').count(), 2); assert.equal((await session()).layout.ratio, ratio);
  assert.ok((await session()).documents.find(doc => doc.path === files.Beta).content.includes('Dirty Beta'));
  assert.equal(await page.locator('.editor-pane').nth(0).locator('.ProseMirror h1').textContent(), 'Alpha');
  assert.ok((await page.locator('.editor-pane').nth(0).locator('.ProseMirror').innerText()).includes('Alpha edit'));
  assert.ok((await page.locator('.editor-pane').nth(1).locator('.source-editor').innerText()).includes('Dirty Beta'));
  assert.deepEqual((await session()).documents.map(doc => [path.basename(doc.path), doc.mode]).sort(), [['Alpha.md', 'visual'], ['Beta.md', 'source']]);
  pass('Escape cancels tab docking, and restart restores split proportions plus unsaved document content');

  const separator = page.getByRole('separator', { name: '调整分栏大小' });
  await focus(); await idle();
  await separator.press('Home'); await poll(async () => (await session()).layout.ratio === .5, 'keyboard divider reset'); await idle();
  await separator.press('ArrowRight'); await poll(async () => (await session()).layout.ratio === .55, 'keyboard divider resize'); await idle();
  assert.equal(await separator.evaluate(node => document.activeElement === node), true);
  pass('the separator supports keyboard resizing and restoring equal columns');

  await tabs('Beta').click(); await idle();
  await app.evaluate((_electron, files) => {
    const fs = process.getBuiltinModule('node:fs/promises'); globalThis.paneTestRename = fs.rename; globalThis.paneActivationStarted = false;
    fs.rename = async (...args) => {
      if (String(args[1]).endsWith('windows-v1.json')) {
        const session = JSON.parse(await fs.readFile(args[0], 'utf8')).windows[0].session;
        const alpha = session.documents.find(doc => doc.path === files.Alpha), beta = session.documents.find(doc => doc.path === files.Beta);
        if (alpha && beta && session.activeId === alpha.id && !globalThis.paneActivationStarted) {
          globalThis.paneActivationStarted = true;
          await new Promise(resolve => { globalThis.releasePaneActivation = resolve; });
        }
        if (!alpha && beta) throw Error('pane-close-write-failure');
      }
      return globalThis.paneTestRename(...args);
    };
  }, files);
  await page.locator('.editor-pane').first().locator('.ProseMirror h1').click();
  await poll(() => app.evaluate(() => typeof globalThis.releasePaneActivation === 'function'), 'activation save is still pending');
  await page.locator('.active-pane [data-close-tab]').evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 1 && document.body.classList.contains('is-busy'));
  await app.evaluate(() => globalThis.releasePaneActivation());
  await page.locator('#toast').filter({ hasText: 'pane-close-write-failure' }).waitFor(); await idle();
  await app.evaluate(() => { process.getBuiltinModule('node:fs/promises').rename = globalThis.paneTestRename; delete globalThis.paneTestRename; delete globalThis.paneActivationStarted; delete globalThis.releasePaneActivation; });
  await poll(async () => await page.locator('.editor-pane').count() === 2 &&
    (await page.locator('.editor-pane').first().locator('.ProseMirror').innerText()).includes('Alpha edit') &&
    (await page.locator('.editor-pane').last().locator('.source-editor').innerText()).includes('Dirty Beta'), 'failed close restored both pane views');
  assert.equal(await page.locator('.editor-pane').count(), 2);
  assert.ok((await page.locator('.editor-pane').first().locator('.ProseMirror').innerText()).includes('Alpha edit'));
  assert.ok((await page.locator('.editor-pane').last().locator('.source-editor').innerText()).includes('Dirty Beta'));
  await tabs('Beta').click(); await idle();
  pass('an older pending save cannot destroy a closing editor before its own commit; a failed close restores both live panes');

  await tabs('Beta').click(); await openFile('Gamma');
  const gammaPane = page.locator('.editor-pane').filter({ has: page.locator('.pane-tabs [role="tab"]', { hasText: 'Gamma' }) });
  assert.equal(await gammaPane.locator('[role="tab"]').count(), 2);
  await split('Gamma', gammaPane, 'bottom', 3);
  await tabs('Alpha').click(); await openFile('Delta');
  await split('Delta', page.locator('.editor-pane').filter({ has: page.locator('.pane-tabs [role="tab"]', { hasText: 'Alpha' }) }), 'left', 4);
  await openFile('Extra'); const beforeLimit = JSON.stringify((await session()).layout);
  await drag('Extra', await bodyPoint(page.locator('.active-pane'), 'top')); await page.mouse.up();
  await page.locator('#toast').filter({ hasText: '最多分成 4 栏' }).waitFor();
  assert.equal(await page.locator('.editor-pane').count(), 4); assert.equal(JSON.stringify((await session()).layout), beforeLimit);
  await page.screenshot({ path: path.join(run, 'four-panes.png') });
  pass('nested horizontal and vertical docking supports four panes, opens documents in the active group and rejects excess splits without loss');

  await (await app.browserWindow(page)).evaluate(win => win.setSize(760, 600));
  const sizes = await page.locator('.editor-pane').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  assert.ok(sizes.every(size => size.width >= 239 && size.height >= 159));
  await page.screenshot({ path: path.join(run, 'narrow-panes.png') });
  await (await app.browserWindow(page)).evaluate(win => win.setSize(1280, 880));
  pass('narrow windows keep every editor usable and scroll the workspace instead of squeezing panes below their minimum size');

  await page.locator('.active-pane .document-tab').filter({ has: tabs('Extra') }).locator('[data-close-tab]').click();
  await poll(async () => { const state = await session(); return state.documents.find(doc => doc.id === state.activeId)?.path === files.Delta; }, 'close selects a sibling in the same pane'); await idle();
  await page.waitForFunction(() => document.activeElement?.closest('#visual-editor'));
  await action('reopen-closed'); await poll(async () => (await session()).documents.some(doc => doc.path === files.Extra), 'reopen in the active pane'); await idle();
  assert.equal(await page.locator('.editor-pane').count(), 4);
  assert.equal(await page.locator('.active-pane [role="tab"]').count(), 2);
  pass('closing selects another document in the same pane, and reopening restores it there with editing focus');

  // Merge a group using the visible control: documents remain open, no discard prompt.
  const priorDocs = (await session()).documents.map(doc => doc.id).sort();
  await page.locator('.active-pane [data-merge-pane]').click(); await poll(async () => await page.locator('.editor-pane').count() === 3, 'merge pane'); await idle();
  assert.deepEqual((await session()).documents.map(doc => doc.id).sort(), priorDocs);
  const target = page.locator('.editor-pane').filter({ has: page.locator('.pane-tabs [role="tab"]', { hasText: 'Alpha' }) }).first();
  const strip = await target.locator('.pane-tabs').boundingBox();
  await drag('Beta', { x: strip.x + 12, y: strip.y + strip.height / 2 }); await page.mouse.up(); await poll(async () => await page.locator('.editor-pane').count() === 2, 'drop into tab strip'); await idle();
  assert.ok((await session()).documents.find(doc => doc.path === files.Beta).content.includes('Dirty Beta'));
  pass('dropping into a tab strip and collapsing a pane merge documents without closing, saving or discarding them');

  // Deny the authoritative session write to exercise rollback of a failed dock.
  const previousLayout = JSON.stringify((await session()).layout);
  await app.evaluate(() => { const fs = process.getBuiltinModule('node:fs/promises'); globalThis.paneTestRename = fs.rename; fs.rename = async (...args) => { if (String(args[1]).endsWith('windows-v1.json')) throw Error('pane-test-write-failure'); return globalThis.paneTestRename(...args); }; });
  const two = page.locator('.editor-pane'); await drag('Beta', await bodyPoint(two.first(), 'top')); await page.mouse.up();
  await page.locator('#toast').filter({ hasText: 'pane-test-write-failure' }).waitFor();
  assert.equal(await page.locator('.editor-pane').count(), 2); assert.equal(JSON.stringify((await session()).layout), previousLayout);
  await app.evaluate(() => { process.getBuiltinModule('node:fs/promises').rename = globalThis.paneTestRename; delete globalThis.paneTestRename; });
  assert.deepEqual((await session()).documents.map(doc => doc.id).sort(), priorDocs);
  pass('failed session persistence rolls back docking and retains every document and dirty buffer');
  await setting('MOYE_TEST_WINDOW_FAILURE', '1');
  await drag('Beta', { x: -45, y: 200 }, false); await page.mouse.up();
  await page.locator('#toast').filter({ hasText: '模拟新窗口启动失败' }).waitFor(); await idle();
  assert.equal(app.windows().length, 1); assert.equal(JSON.stringify((await session()).layout), previousLayout);
  assert.deepEqual((await session()).documents.map(doc => doc.id).sort(), priorDocs);
  await setting('MOYE_TEST_WINDOW_FAILURE', '0');
  pass('failed destination startup restores the original split layout and document ownership durably');
  const created = app.waitForEvent('window');
  await drag('Beta', { x: -45, y: 200 }, false); await page.mouse.up();
  const detached = await created; await detached.waitForSelector('#shell[data-ready="true"]'); await idle();
  const movedWindows = JSON.parse(await fs.readFile(path.join(profile, 'windows-v1.json'), 'utf8')).windows;
  const movedDoc = movedWindows.flatMap(record => record.session.documents).find(doc => doc.path === files.Beta);
  assert.ok(movedDoc.content.includes('Dirty Beta')); assert.equal(movedDoc.id, beta.id);
  assert.equal(movedWindows.filter(record => record.session.documents.some(doc => doc.path === files.Beta)).length, 1);
  pass('dragging outside the application detaches a dirty document into an independent window without duplicating ownership');
  assert.deepEqual(errors, []); pass('no renderer exceptions across split editing, resizing, merging, recovery and rollback');
} finally {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  const diagnostics = page && !page.isClosed() ? await page.evaluate(() => ({ keys: globalThis.paneKeyTrace, toast: document.querySelector('#toast')?.textContent, ratio: document.querySelector('.pane-divider')?.getAttribute('aria-valuenow') })).catch(() => null) : null;
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, diagnostics }, null, 2)); await stop(); console.log(`Evidence: ${run}`);
}

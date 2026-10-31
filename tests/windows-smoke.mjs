import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'windows-'))), profile = path.join(run, 'profile');
const folder = path.join(run, 'notes'), otherFolder = path.join(run, 'other'); await fs.mkdir(folder); await fs.mkdir(otherFolder);
const a = path.join(folder, 'Alpha.md'), b = path.join(folder, 'Beta.md'), c = path.join(otherFolder, 'Gamma.md');
await fs.writeFile(a, '\uFEFF# Alpha\r\n\r\nOriginal A\r\n'); await fs.writeFile(b, '# Beta\n'); await fs.writeFile(c, '# Gamma\n');
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_FOLDER_PATH: folder, MOYE_TEST_DISCARD: 'cancel', MOYE_TEST_CONFLICT: 'cancel' }; delete env.ELECTRON_RUN_AS_NODE;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const results = [], errors = []; let app;
const tracked = new Set();
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function poll(check, timeout = 20000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Timed out waiting for multi-window state'); }
async function ready(page) { page.setDefaultTimeout(15000); if (!tracked.has(page)) { tracked.add(page); page.on('pageerror', error => errors.push(error.message)); } await page.waitForSelector('#shell[data-ready="true"]'); return page; }
async function native(page, action) { const win = await app.browserWindow(page); return win.evaluate((win, action) => { if (action === 'focus') { win.show(); win.focus(); } else if (action === 'close') win.close(); else return win.getBounds(); }, action); }
async function idle(page) { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(page, name) {
  await idle(page);
  if (name === 'folder') await page.keyboard.press(`${modifier}+Shift+O`);
  else if (['new-window', 'detach-document', 'tile-windows'].includes(name)) {
    await native(page, 'focus'); await page.waitForFunction(() => document.hasFocus());
    if (!await page.locator('#window-panel').isVisible()) await page.locator('[data-action="window-menu"]').click();
    await page.locator(`#window-panel [data-action="${name}"]`).click();
  }
  else await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click());
  await idle(page);
}
async function setting(name, value) { await app.evaluate((_electron, { name, value }) => { process.env[name] = value; }, { name, value }); }
async function open(page, file) { await setting('MOYE_TEST_OPEN_PATH', file); await action(page, 'open'); }
async function source(page) { await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content'); }
async function append(page, value) { await native(page, 'focus'); const editor = await source(page); await editor.click(); await page.keyboard.press(end); await page.keyboard.insertText(value); }
async function text(page) { return page.locator('#source-editor .cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n')); }
async function tab(page, file) { await page.locator('.document-tab [role="tab"]').evaluateAll((nodes, file) => nodes.find(node => node.title === file).click(), file); await idle(page); }
async function catalog() { return JSON.parse(await fs.readFile(path.join(profile, 'windows-v1.json'), 'utf8')).windows; }
async function windowId(page) { return page.evaluate(async () => (await window.moye.boot()).windowId); }
async function active(page) { const id = await windowId(page), record = (await catalog()).find(record => record.id === id); return record.session.documents.find(doc => doc.id === record.session.activeId); }
async function newWindow(page, command = 'new-window') { const created = app.waitForEvent('window'); await action(page, command); return ready(await created); }
async function launch(args = []) {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  app.on('window', page => { void ready(page).catch(() => {}); });
  const page = await ready(await app.firstWindow()); await native(page, 'focus'); return page;
}
async function crash() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function quit() { const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 20); }); await closed; app = null; }
try {
  let first = await launch(['--open', a]); await action(first, 'folder'); await append(first, '\nA unsaved before new window'); await open(first, b);
  let second = await newWindow(first);
  assert.equal(app.windows().length, 2); assert.equal(await first.locator('.document-tab').count(), 2); assert.equal((await active(second)).path, null);
  await tab(first, a); assert.match(await text(first), /A unsaved before new window/);
  pass('new native windows have independent tabs and preserve existing unsaved documents');

  await open(second, a); assert.equal(await second.locator('.document-tab').count(), 1); assert.equal((await active(second)).path, null);
  await open(second, c); await append(second, '\nC independent edit');
  await Promise.all([action(first, 'save'), action(second, 'save')]);
  assert.match(await fs.readFile(a, 'utf8'), /A unsaved/); assert.match(await fs.readFile(c, 'utf8'), /C independent/);
  assert.ok((await fs.readFile(a, 'utf8')).startsWith('\uFEFF# Alpha\r\n'));
  pass('opening an owned file focuses its existing window; independent saves preserve content and BOM/CRLF');

  await action(first, 'toggle-autosave'); await poll(() => second.locator('#toggle-autosave').getAttribute('aria-pressed').then(value => value === 'true'));
  await action(first, 'toggle-autosave'); await poll(() => second.locator('#toggle-autosave').getAttribute('aria-pressed').then(value => value === 'false'));
  await setting('MOYE_TEST_FOLDER_PATH', otherFolder); await action(second, 'folder');
  assert.equal((await first.evaluate(() => window.moye.boot())).workspace.root, folder);
  assert.equal((await second.evaluate(() => window.moye.boot())).workspace.root, otherFolder);
  assert.equal(await first.evaluate(async file => { try { await window.moye.openDocument(file); return false; } catch { return true; } }, c), true);
  pass('settings propagate between windows while workspace selection and file authorization stay scoped to each window');

  await append(first, '\nMove this dirty buffer'); await poll(async () => (await active(first)).content.includes('Move this dirty buffer'));
  const beforeMove = await active(first), diskA = await fs.readFile(a);
  const snapshot = await first.evaluate(doc => window.moye.createSnapshot({ ...doc, tabId: doc.id, kind: 'manual', label: 'Before move' }), beforeMove);
  let third = await newWindow(first, 'detach-document');
  assert.equal(await first.locator('.document-tab').count(), 1); assert.equal((await active(third)).id, beforeMove.id);
  assert.equal(await text(third), beforeMove.content); assert.equal(await third.locator('#dirty-dot').isVisible(), true);
  assert.equal(await third.locator('#recovery-banner').isVisible(), false); assert.deepEqual(await fs.readFile(a), diskA);
  assert.equal((await third.evaluate(target => window.moye.listSnapshots(target), { path: a, tabId: beforeMove.id }))[0].id, snapshot.id);
  pass('detaching a dirty tab moves its stable identity, text, mode and snapshots only after the new editor is ready');

  await setting('MOYE_TEST_SAVE_PATH', a); await action(first, 'saveAs');
  assert.match(await first.locator('#toast').innerText(), /另一个窗口/); assert.deepEqual(await fs.readFile(a), diskA);
  await open(first, a); assert.equal(await first.locator('.document-tab').count(), 1);
  const ownership = (await catalog()).flatMap(record => record.session?.documents || []).filter(doc => doc.path === a); assert.equal(ownership.length, 1);
  pass('cross-window Save As cannot overwrite an owned file and repeated opens never duplicate its live buffer');

  await setting('MOYE_TEST_WINDOW_FAILURE', '1'); await action(third, 'detach-document'); await setting('MOYE_TEST_WINDOW_FAILURE', '0');
  assert.equal(app.windows().length, 3); assert.equal(await text(third), beforeMove.content);
  assert.equal((await active(third)).id, beforeMove.id); assert.match(await third.locator('#toast').innerText(), /启动失败/);
  pass('failed destination startup rolls the durable transfer back without losing the source tab');

  const blocked = await first.evaluate(async file => { try { await window.moye.workspaceOperation({ action: 'rename', path: file, name: 'renamed.md' }); return false; } catch (error) { return String(error).includes('其他窗口'); } }, a);
  assert.equal(blocked, true); assert.ok(await fs.stat(a));
  await append(second, '\nCancel closing this window'); await native(second, 'close'); await poll(() => second.locator('#document-scroll').evaluate(node => !node.closest('[inert]')));
  assert.equal(app.windows().length, 3); assert.match(await text(second), /Cancel closing/);
  await setting('MOYE_TEST_DISCARD', 'discard'); await native(second, 'close'); await poll(() => app.windows().length === 2);
  assert.equal((await catalog()).length, 2); assert.equal(await text(third), beforeMove.content);
  pass('filesystem moves protect other windows; canceling or closing one window leaves the remaining editors intact');

  await append(first, '\nB kept when quit is canceled');
  await setting('MOYE_TEST_DISCARD_SEQUENCE', JSON.stringify(['discard', 'cancel']));
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 20); });
  await poll(() => app.evaluate(() => process.env.MOYE_TEST_DISCARD_SEQUENCE === '[]'));
  await idle(first); await idle(third);
  assert.equal(app.windows().length, 2); assert.match(await text(first), /B kept when quit/); assert.equal(await text(third), beforeMove.content);
  assert.ok((await catalog()).every(record => record.session.documents.some(doc => doc.dirty)));
  pass('canceling application quit keeps every window and every earlier discarded buffer recoverable');

  await setting('MOYE_TEST_DISCARD', 'save'); await quit();
  assert.match(await fs.readFile(b, 'utf8'), /B kept when quit/); assert.match(await fs.readFile(a, 'utf8'), /Move this dirty buffer/);
  await fs.writeFile(a, '# Fresh external A\n');
  first = await launch(); await poll(() => app.windows().length === 2); for (const page of app.windows()) await ready(page);
  third = app.windows().find(page => page !== first);
  const pagesByName = new Map(await Promise.all(app.windows().map(async page => [await page.locator('#document-name').innerText(), page])));
  const aPage = pagesByName.get('Alpha.md'), bPage = pagesByName.get('Beta.md'); assert.ok(aPage && bPage);
  await source(aPage); assert.equal(await text(aPage), '# Fresh external A\n');
  pass('normal application quit saves all windows and reopening restores them using fresh disk bytes');

  await action(bPage, 'new'); await append(bPage, 'Untitled window recovery α'); await poll(async () => (await active(bPage)).content.includes('Untitled window recovery'));
  const draft = await active(bPage);
  const draftSnapshot = await bPage.evaluate(doc => window.moye.createSnapshot({ ...doc, tabId: doc.id, kind: 'manual', label: 'Untitled before move' }), draft);
  const draftPage = await newWindow(bPage, 'detach-document');
  assert.equal((await active(draftPage)).id, draft.id); assert.equal((await active(draftPage)).path, null);
  assert.equal((await draftPage.evaluate(target => window.moye.listSnapshots(target), { path: null, tabId: draft.id }))[0].id, draftSnapshot.id);
  await append(aPage, '\nSecond dirty window β');
  await aPage.locator('.tab-settings').click(); await aPage.locator('#reopen-session').uncheck(); await aPage.locator('.tab-settings').click();
  await poll(() => aPage.evaluate(async () => !(await window.moye.boot()).settings.reopenSession));
  await pageWaitForRecovery(aPage, draftPage); await crash();
  first = await launch(); await poll(() => app.windows().length === 2); for (const page of app.windows()) await ready(page);
  const contents = [];
  for (const page of app.windows()) { await source(page); contents.push(await text(page)); assert.equal(await page.locator('#recovery-banner').isVisible(), true); }
  assert.ok(contents.some(value => value.includes('Untitled window recovery α'))); assert.ok(contents.some(value => value.includes('Second dirty window β')));
  pass('untitled moves retain snapshot ownership and crashes restore dirty documents across windows with reopen-session disabled');

  const pair = app.windows(); await action(pair[0], 'tile-windows');
  const rectangles = await Promise.all(pair.map(page => native(page, 'bounds'))); rectangles.sort((x, y) => x.x - y.x);
  assert.ok(rectangles[0].x + rectangles[0].width <= rectangles[1].x + 2);
  for (const [index, page] of pair.entries()) {
    const scroll = await page.locator('#document-scroll').boundingBox(); assert.ok(scroll.width > 250);
    await page.screenshot({ path: path.join(run, `side-${index + 1}.png`), animations: 'disabled' });
  }
  const narrowWindow = await app.browserWindow(pair[0]);
  for (const width of [600, 480]) {
    await narrowWindow.evaluate((win, width) => win.setSize(width, 680), width);
    await poll(() => pair[0].evaluate(() => innerWidth <= 600));
    await pair[0].locator('[data-action="window-menu"]').click();
    const panel = await pair[0].locator('#window-panel').boundingBox(), viewport = await pair[0].evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width);
    assert.ok(panel.y + panel.height < viewport.height);
    await pair[0].keyboard.press('Escape'); assert.equal(await pair[0].locator('#window-panel').isVisible(), false);
    const saveButton = await pair[0].locator('.save-button').boundingBox(); assert.ok(saveButton.x + saveButton.width <= viewport.width);
    await pair[0].screenshot({ path: path.join(run, `narrow-${width}.png`), animations: 'disabled' });
  }
  pass('side-by-side arrangement uses the current display without overlapping the two editor windows');

  const filePage = await findPageByPath(a), draftWindow = pair.find(page => page !== filePage);
  await append(filePage, '\nNative menu targets this window'); await setting('MOYE_TEST_SAVE_PATH', path.join(run, 'unexpected.md')); await native(filePage, 'focus');
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === '保存').click(); });
  await poll(async () => (await fs.readFile(a, 'utf8')).includes('Native menu targets this window'));
  assert.equal((await active(draftWindow)).path, null); assert.equal(await fs.stat(path.join(run, 'unexpected.md')).catch(() => null), null);
  // macOS keeps the application alive after its last window closes. Exercise that path on every host.
  await app.evaluate(({ app }) => app.removeAllListeners('window-all-closed'));
  await setting('MOYE_TEST_DISCARD', 'discard');
  await native(draftWindow, 'close'); await poll(() => app.windows().length === 1);
  await native(filePage, 'close'); await poll(() => app.windows().length === 0);
  const reopenedWindow = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => {
    const reopen = Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === '重新打开窗口');
    reopen.click(); reopen.click();
  });
  await ready(await reopenedWindow); assert.equal(app.windows().length, 1);
  assert.deepEqual(errors, []);
  pass('native menus target the focused window and can reopen the last closed editor without renderer errors');
} finally {
  if (app) for (const [index, page] of app.windows().entries()) { await page.screenshot({ path: path.join(run, `last-${index}.png`), animations: 'disabled', timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, `last-${index}.html`), await page.content().catch(() => '')); }
  await crash(); await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}
async function pageWaitForRecovery(...pages) { for (const page of pages) await poll(async () => (await active(page)).dirty); await new Promise(resolve => setTimeout(resolve, 900)); }
async function findPageByPath(file) { for (const page of app.windows()) if ((await active(page)).path === file) return page; throw Error('Missing document window'); }

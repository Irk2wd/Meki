import { readWindows } from './recovery-fixture.cjs';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'shortcuts-reopen-'))), file = path.join(run, 'clean.md'), owned = path.join(run, 'owned.md');
await fs.writeFile(file, '# Original\n\nOriginal saved body.\n'); await fs.writeFile(owned, '# Owned\n\nSaved owner body.\n');
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'shortcuts-profile'), MEKI_TEST_OPEN_PATH: file, MEKI_TEST_DISCARD: 'discard', MEKI_TEST_CONFLICT: 'cancel' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
let app, page; const results = [], errors = [], tracked = new Set();
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function poll(check, message, timeout = 20000) { const limit = Date.now() + timeout; while (Date.now() < limit) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); } throw Error(`Timed out: ${message}`); }
async function ready(target) { target.setDefaultTimeout(15000); if (!tracked.has(target)) { tracked.add(target); target.on('pageerror', error => errors.push(error.message)); } await target.waitForSelector('#shell[data-ready="true"]'); return target; }
async function focus(target = page) { await (await app.browserWindow(target)).evaluate(win => { win.show(); win.focus(); }); }
async function idle(target = page) { await target.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name, target = page) { await idle(target); await target.locator(name === 'close-tab' ? '.document-tab.active .close-document-tab' : `[data-action="${name}"]`).first().evaluate(node => node.click()); }
async function setting(name, value) { await app.evaluate((_electron, { name, value }) => { process.env[name] = value; }, { name, value }); }
async function active(target = page) { const id = await target.evaluate(async () => (await window.meki.boot()).windowId); const records = await readWindows(env.MEKI_USER_DATA); const session = records.find(item => item.id === id)?.session; return session?.documents.find(item => item.id === session.activeId); }
async function launch() { app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? [] : [root], env, timeout: 30000 }); page = await ready(await app.firstWindow()); await focus(); return page; }
async function stop() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function tabs(target = page) { return target.locator('.document-tab').count(); }
async function open(filePath, target = page) { await setting('MEKI_TEST_OPEN_PATH', filePath); await action('open', target); await poll(async () => (await active(target))?.path === filePath, 'document opens'); await idle(target); }
async function source(target = page) { await focus(target); await idle(target); await target.locator('[data-mode="source"]').click(); await target.locator('#source-editor').waitFor({ state: 'visible' }); return target.locator('#source-editor .cm-content'); }
async function text(target = page) { return target.locator('#source-editor .cm-line').evaluateAll(nodes => nodes.map(node => node.textContent).join('\n')); }
async function append(value, target = page) { const editor = await source(target); await editor.click(); await target.keyboard.press(end); await target.keyboard.insertText(value); await poll(async () => (await active(target))?.content.includes(value), 'edited buffer persists'); }
async function closeTab(target = page) { const before = (await active(target)).id; await action('close-tab', target); await poll(async () => (await active(target))?.id !== before, 'tab closes'); await idle(target); }
async function reopen(target = page) { const before = (await active(target)).id; await action('reopen-closed', target); await poll(async () => (await active(target))?.id !== before, 'closed document restores'); await idle(target); }
async function newWindow(target = page) { const created = app.waitForEvent('window'); await action('new-window', target); return ready(await created); }
async function settings(target = page) { return target.evaluate(async () => (await window.meki.boot()).settings); }
async function shortcuts(target = page) { await action('shortcut-settings', target); await target.locator('#shortcuts-dialog').waitFor({ state: 'visible' }); }
async function closeShortcuts(target = page) { await target.locator('[aria-label="关闭快捷键设置"]').click(); }
async function record(command, key, target = page, success = true) {
  await focus(target); await target.locator(`[data-shortcut-id="${command}"][data-shortcut-action="record"]`).click(); await target.keyboard.press(key);
  if (success) { await target.waitForFunction(() => document.querySelector('#shortcut-feedback')?.textContent === '快捷键已保存。'); await target.waitForFunction(() => !document.querySelector('#shortcut-reset-all').disabled); }
}
async function menuAccelerator(command) { return app.evaluate(({ Menu }, command) => Menu.getApplicationMenu().getMenuItemById(`command-${command}`).accelerator, command); }
async function save(target = page) { await action('save', target); await poll(async () => !(await active(target))?.dirty, 'manual save completes'); await idle(target); }
try {
  await launch(); await open(file); await shortcuts(); await record('new', `${mod}+J`);
  assert.equal((await settings()).shortcuts.new, 'Mod+J'); assert.equal(await menuAccelerator('new'), process.platform === 'darwin' ? 'Cmd+J' : 'Ctrl+J');
  await record('save', `${mod}+J`, page, false); await page.waitForFunction(() => document.querySelector('#shortcut-feedback')?.textContent.includes('冲突'));
  assert.equal((await settings()).shortcuts.save, undefined); await page.keyboard.press('Escape');
  await record('save', `${mod}+B`, page, false); await page.waitForFunction(() => document.querySelector('#shortcut-feedback')?.textContent.includes('保留'));
  await page.keyboard.press('Escape'); await closeShortcuts();
  pass('recorded shortcuts persist, appear in native menus and reject conflicts and reserved editing keys');

  let count = await tabs(); await page.keyboard.press(`${mod}+N`); await page.waitForTimeout(120); assert.equal(await tabs(), count);
  await page.keyboard.press(`${mod}+J`); await poll(async () => await tabs() === count + 1, 'custom new shortcut'); await idle();
  await page.waitForTimeout(150); assert.equal(await tabs(), count + 1, 'native accelerator and renderer must not create two tabs');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-new').click()); await poll(async () => await tabs() === count + 2, 'native menu new'); await idle();
  pass('retired defaults stop triggering; a custom key and a native menu click each dispatch exactly once');

  await shortcuts(); await page.locator('[data-shortcut-id="new"][data-shortcut-action="clear"]').click();
  await poll(async () => (await settings()).shortcuts.new === null, 'clear shortcut'); await closeShortcuts(); count = await tabs(); await page.keyboard.press(`${mod}+J`); await page.keyboard.press(`${mod}+N`); await page.waitForTimeout(120); assert.equal(await tabs(), count);
  await shortcuts(); await page.locator('[data-shortcut-id="new"][data-shortcut-action="reset"]').click();
  await poll(async () => (await settings()).shortcuts.new === undefined, 'reset individual shortcut'); await closeShortcuts(); await page.keyboard.press(`${mod}+N`); await poll(async () => await tabs() === count + 1, 'restored default'); await idle();
  pass('clearing disables a command shortcut and single-item reset restores its original key');

  await shortcuts(); await record('source', `${mod}+Shift+J`); await record('find', `${mod}+Shift+P`); await record('edit-link', `${mod}+Alt+L`); await record('edit-copy-text', `${mod}+Shift+Y`); await closeShortcuts();
  await page.keyboard.press(`${mod}+/`); assert.equal(await page.locator('#visual-editor').isVisible(), true);
  await page.keyboard.press(`${mod}+Shift+J`); await page.locator('#source-editor').waitFor({ state: 'visible' });
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+F`); assert.equal(await page.locator('#find-panel').isVisible(), false); assert.equal(await page.locator('.cm-panel.cm-search').count(), 0);
  await page.keyboard.press(`${mod}+Shift+P`); await page.locator('#find-panel').waitFor({ state: 'visible' }); await action('find-close');
  await page.keyboard.press(`${mod}+Alt+K`); assert.equal(await page.locator('#insert-dialog').isVisible(), false);
  await page.keyboard.press(`${mod}+Alt+L`); await page.locator('#insert-dialog').waitFor({ state: 'visible' }); await page.locator('[aria-label="取消插入"]').click();
  await append('clipboard custom command'); await source(); await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+A`);
  await page.evaluate(() => window.meki.writeClipboardText('sentinel')); await page.keyboard.press(`${mod}+Shift+C`); await page.waitForTimeout(120); assert.equal(await page.evaluate(() => window.meki.readClipboardText()), 'sentinel');
  await page.keyboard.press(`${mod}+Shift+Y`); await page.waitForFunction(async () => (await window.meki.readClipboardText()).includes('clipboard custom command'));
  pass('source, find, link and clipboard commands use the new map; old Find cannot open CodeMirror search');

  const busySave = path.join(run, 'busy-save.md'), beforeBusySave = (await active()).content;
  await setting('MEKI_TEST_SAVE_PATH', busySave); await setting('MEKI_TEST_SAVE_DELAY', '3000');
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(end); count = await tabs(); await action('save');
  await poll(() => app.evaluate(() => process.env.MEKI_TEST_SAVE_PENDING === '1'), 'native delayed save is pending');
  assert.equal(await page.evaluate(() => document.body.classList.contains('is-busy')), true);
  await page.keyboard.press(`${mod}+F`); await page.keyboard.press(`${mod}+Shift+P`); await page.keyboard.press(`${mod}+Shift+J`); await page.keyboard.press(`${mod}+N`);
  assert.equal(await page.locator('.cm-panel.cm-search').count(), 0); assert.equal(await page.locator('#find-panel').isVisible(), false);
  assert.equal(await page.locator('#source-editor').isVisible(), true); assert.equal(await tabs(), count);
  await page.keyboard.type(' Busy typing remains editable');
  assert.equal(await app.evaluate(() => process.env.MEKI_TEST_SAVE_PENDING === '1'), true, 'key assertions must run during the real pending save');
  assert.match(await text(), /Busy typing remains editable/);
  await idle(); await setting('MEKI_TEST_SAVE_DELAY', '0');
  assert.equal(await fs.readFile(busySave, 'utf8'), beforeBusySave); assert.equal((await active()).dirty, true);
  pass('a real pending save consumes mapped and retired application keys while ordinary source typing remains editable');

  count = await tabs(); await action('math'); await page.locator('#math-dialog').waitFor({ state: 'visible' }); await page.keyboard.press(`${mod}+N`); assert.equal(await tabs(), count); await page.locator('[aria-label="关闭公式窗口"]').click();
  await page.evaluate(platform => {
    const base = { key: 'n', code: 'KeyN', bubbles: true, cancelable: true, ctrlKey: platform !== 'darwin', metaKey: platform === 'darwin' };
    document.dispatchEvent(new KeyboardEvent('keydown', { ...base, isComposing: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { ...base, repeat: true }));
    const alt = new KeyboardEvent('keydown', { ...base, altKey: true }); Object.defineProperty(alt, 'getModifierState', { value: key => key === 'AltGraph' }); document.dispatchEvent(alt);
    document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  }, process.platform);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-new').click()); await page.waitForTimeout(120); assert.equal(await tabs(), count);
  await page.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  pass('modal dialogs, IME composition, AltGraph and key-repeat do not dispatch application commands');

  const second = await newWindow(); await shortcuts(second); await record('new', `${mod}+J`, second); await closeShortcuts(second);
  await poll(async () => (await page.locator('#open-shortcut').textContent()) !== null && (await page.locator('[data-shortcut-value="new"]').textContent())?.includes('J'), 'cross-window shortcut synchronization');
  await focus(); assert.equal(await menuAccelerator('new'), process.platform === 'darwin' ? 'Cmd+J' : 'Ctrl+J');
  await (await app.browserWindow(second)).evaluate(win => win.close()); await poll(() => Promise.resolve(app.windows().length === 1), 'second window closes');
  await stop(); await launch(); await shortcuts(); assert.match(await page.locator('[data-shortcut-value="new"]').innerText(), /J/); assert.match(await page.locator('[data-shortcut-value="source"]').innerText(), /J/);
  await page.locator('#shortcut-reset-all').click(); await poll(async () => Object.keys((await settings()).shortcuts).length === 0, 'all defaults restored'); await closeShortcuts();
  pass('shortcut changes synchronize across native windows, survive restart and can all be restored to defaults');

  await stop(); env.MEKI_USER_DATA = path.join(run, 'reopen-profile'); await launch(); await open(file); await source();
  await closeTab(); const latest = '# Latest disk\n\nDisk changed after clean close.\n' + 'Long paragraph for scroll preservation.\n\n'.repeat(90); await fs.writeFile(file, latest);
  await page.keyboard.press(`${mod}+Shift+T`); await poll(async () => (await active())?.path === file, 'default reopen shortcut'); await idle();
  assert.equal((await active()).content, latest); assert.equal((await active()).dirty, false); assert.equal(await page.locator('#source-editor').isVisible(), true);
  await page.locator('#source-editor .cm-scroller').evaluate(node => { node.scrollTop = 480; });
  await closeTab(); await reopen(); assert.ok(await page.locator('#source-editor .cm-scroller').evaluate(node => node.scrollTop) > 350);
  pass('reopening a clean document rereads current disk bytes and preserves source mode and scroll position');

  await action('lifecycle-settings'); await page.locator('#auto-save-interval').selectOption('2'); await poll(async () => (await settings()).autoSaveInterval === 2, 'autosave interval updates'); await action('lifecycle-settings');
  await action('toggle-autosave'); await poll(async () => (await settings()).autoSave === true, 'autosave enables');
  await append('\nClosed unsaved text'); await closeTab(); assert.equal(await fs.readFile(file, 'utf8'), latest); await reopen();
  const restored = await active(); assert.equal(restored.path, file); assert.equal(restored.paused, 'recovered'); assert.equal(restored.dirty, true); assert.match(restored.content, /Closed unsaved text/);
  await page.waitForTimeout(2300); assert.equal(await fs.readFile(file, 'utf8'), latest);
  await append('\nUndo this fresh edit'); await page.keyboard.press(`${mod}+Z`); await poll(async () => !(await active()).content.includes('Undo this fresh edit'), 'undo after reopening'); await save();
  assert.equal((await active()).paused, null); assert.match(await fs.readFile(file, 'utf8'), /Closed unsaved text/); await action('toggle-autosave'); await poll(async () => (await settings()).autoSave === false, 'autosave disables');
  pass('discarded edits return with autosave paused; fresh edits can undo and an explicit save resumes normal saving');

  await closeTab(); await fs.unlink(file); await reopen(); assert.equal((await active()).path, null); assert.equal((await active()).paused, 'recovered');
  assert.match((await active()).content, /Closed unsaved text/); await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const rescued = path.join(run, 'rescued.md'); await setting('MEKI_TEST_SAVE_PATH', rescued); await save(); assert.equal((await active()).path, rescued);
  await append('\nBuffered before external change'); const closedContent = (await active()).content; await closeTab(); await fs.writeFile(rescued, '# External version must survive\n'); await reopen();
  assert.equal((await active()).path, null); assert.equal((await active()).content, closedContent); assert.equal(await fs.readFile(rescued, 'utf8'), '# External version must survive\n');
  pass('missing files and externally changed dirty files recover into untitled copies without recreating or overwriting disk files');

  await open(owned); await append('\nOwner-window discarded edits'); await closeTab(); const other = await newWindow(); await open(owned, other); await focus(); await reopen();
  assert.equal((await active()).path, null); assert.match((await active()).content, /Owner-window discarded edits/); assert.equal((await active(other)).path, owned); assert.doesNotMatch((await active(other)).content, /discarded edits/);
  assert.equal(await fs.readFile(owned, 'utf8'), '# Owned\n\nSaved owner body.\n');
  pass('a dirty document owned by another window recovers as a separate untitled buffer and preserves the original owner');

  await setting('MEKI_TEST_DISCARD', 'cancel'); let before = await active(); await action('close-tab'); await idle(); await page.waitForTimeout(120); assert.equal((await active()).id, before.id); assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true);
  await setting('MEKI_TEST_DISCARD', 'discard'); await action('new'); await poll(async () => (await active()).id !== before.id, 'new document for close all'); await append('Second discarded buffer');
  count = await tabs(); await setting('MEKI_TEST_DISCARD_SEQUENCE', JSON.stringify(['discard', 'cancel'])); await action('close-all'); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); await poll(() => app.evaluate(() => process.env.MEKI_TEST_DISCARD_SEQUENCE === '[]'), 'close all cancel is consumed');
  assert.equal(await tabs(), count); assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true);
  await action('close-all'); await poll(async () => await tabs() === 1, 'approved close all'); await idle(); assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), false);
  await reopen(); assert.equal((await active()).paused, 'recovered');
  pass('canceling one close or a later close-all confirmation creates no history; fully approved close-all records recoverable buffers');

  const retry = path.join(run, 'retry.md'); await fs.writeFile(retry, '# Retry saved file\n'); await open(retry); await closeTab(); await fs.unlink(retry); await fs.mkdir(retry);
  before = await active(); await action('reopen-closed'); await page.waitForFunction(() => !document.body.classList.contains('is-busy') && document.querySelector('#toast')?.classList.contains('error')); assert.equal((await active()).id, before.id);
  assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), false);
  await fs.rmdir(retry); await fs.writeFile(retry, '# Readable again\n'); await reopen(); assert.equal((await active()).path, retry); assert.equal((await active()).content, '# Readable again\n');
  pass('a failed read keeps the closed record available so retry can succeed later');

  await closeTab(); await stop(); await launch(); assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true);
  const ownerWindow = app.windows().find(target => target !== page); if (ownerWindow) { await ready(ownerWindow); assert.equal(await ownerWindow.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true); }
  before = await active(); const moved = app.waitForEvent('window'); await action('detach-document'); const detached = await ready(await moved);
  await poll(async () => { const current = await active(); return Boolean(current && current.id !== before.id); }, 'detach source updates');
  assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true); assert.equal(await detached.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true);
  await (await app.browserWindow(detached)).evaluate(win => win.close()); await poll(() => Promise.resolve(!app.windows().includes(detached)), 'detached window closes'); assert.equal(await page.locator('.document-tabs [data-action="reopen-closed"]').isDisabled(), true);
  pass('closed history never crosses process restarts, document detaches or window closures');

  await stop(); env.MEKI_USER_DATA = path.join(run, 'cleanup-failure-profile'); await launch();
  const faultFile = path.join(run, 'cleanup-failure.md'); await fs.writeFile(faultFile, '# Authoritative ownership\n'); await open(faultFile);
  const legacyDraft = path.join(env.MEKI_USER_DATA, 'recovery.json'); await fs.mkdir(legacyDraft);
  await closeTab(); assert.equal(await page.locator(`.document-tab [role="tab"][title="${faultFile.replaceAll('\\', '\\\\')}"]`).count(), 0);
  const claimant = await newWindow(); await open(faultFile, claimant); assert.equal((await active(claimant)).path, faultFile);
  await closeTab(claimant); await focus(); await reopen(); assert.equal((await active()).path, faultFile);
  const records = await readWindows(env.MEKI_USER_DATA);
  assert.equal(records.flatMap(record => record.session?.documents || []).filter(doc => doc.path === faultFile).length, 1);
  assert.equal((await active(claimant)).path, null); await fs.rmdir(legacyDraft);
  pass('legacy-draft cleanup failure cannot roll back committed close/reopen UI or desynchronize single-file ownership');
  assert.deepEqual(errors, []); pass('no renderer errors throughout shortcut and closed-document workflows');
} finally {
  if (app && page) { await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.json'), JSON.stringify(await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, shortcut: document.querySelector('#shortcut-feedback')?.textContent, busy: document.body.classList.contains('is-busy'), dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.id) })).catch(() => null), null, 2)); }
  await stop(); await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

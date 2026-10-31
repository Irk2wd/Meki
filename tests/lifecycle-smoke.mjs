import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'lifecycle-')));
const folder = path.join(run, 'documents'), notes = path.join(folder, 'notes');
await fs.mkdir(notes, { recursive: true });
let a = path.join(notes, 'Alpha.md'), b = path.join(notes, 'Beta.md');
const originalA = '\uFEFF# Alpha\r\n\r\nFirst paragraph.\r\n';
await fs.writeFile(a, originalA); await fs.writeFile(b, '# Beta\n\nSecond paragraph.\n');
const profile = path.join(run, 'profile');
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_FOLDER_PATH: folder, MOYE_TEST_DISCARD: 'cancel', MOYE_TEST_CONFLICT: 'cancel' };
delete env.ELECTRON_RUN_AS_NODE;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const redo = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';
const results = [], errors = [];
let app, page;
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { if (name === 'folder') await page.keyboard.press(`${modifier}+Shift+O`); else await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await idle(); }
async function setting(name, value) { await app.evaluate((_electron, { name, value }) => { process.env[name] = value; }, { name, value }); }
async function open(file) { await setting('MOYE_TEST_OPEN_PATH', file); await action('open'); }
async function tab(file) {
  // A disk write can finish before autosave's session commit releases the UI.
  await idle();
  await page.locator('.document-tab [role="tab"]').evaluateAll((buttons, file) => { const button = buttons.find(button => button.title === file); if (!button) throw Error(`Missing tab ${file}`); button.click(); }, file);
  await idle();
  await page.waitForFunction(file => document.querySelector('.document-tab.active [role="tab"]')?.title === file, file);
}
async function source() { await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content'); }
async function append(text) { const editor = await source(); await editor.click(); await page.keyboard.press(end); await page.keyboard.insertText(text); }
async function closeTab() { await page.locator('.document-tab.active .close-document-tab').click(); await idle(); }
async function lifecycleSettings(patch) {
  if (!(await page.locator('#lifecycle-settings').isVisible())) await page.locator('.tab-settings').click();
  await page.locator('#lifecycle-settings').waitFor({ state: 'visible' });
  if (patch.autoSave !== undefined) await page.locator('#auto-save').setChecked(patch.autoSave);
  if (patch.autoSaveInterval !== undefined) await page.locator('#auto-save-interval').selectOption(String(patch.autoSaveInterval));
  if (patch.reopenSession !== undefined) await page.locator('#reopen-session').setChecked(patch.reopenSession);
  await page.locator('.tab-settings').click(); await page.locator('#lifecycle-settings').waitFor({ state: 'hidden' });
}
async function poll(check, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Timed out waiting for lifecycle state');
}
async function launch(args = []) {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]');
}
async function crash() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function normalQuit() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 20); }); await closed; app = null;
}
async function menu(file, command) {
  await page.locator('[data-ws="menu"][data-ws-path]').evaluateAll((nodes, file) => { const node = nodes.find(node => node.dataset.wsPath === file); if (!node) throw Error(`No workspace row ${file}`); node.click(); }, file);
  await page.locator(`[data-ws-menu="${command}"]`).click(); await idle();
}
try {
  await launch(['--open', a]);
  assert.equal((await page.evaluate(() => window.moye.boot())).settings.autoSave, false);
  const settingsControl = await page.locator('.tab-settings').elementHandle();
  await append('\nA source edit'); await open(b); await append('\nB unsaved edit');
  assert.equal(await settingsControl.evaluate(node => node.isConnected && node === document.querySelector('.tab-settings')), true);
  assert.equal(await page.locator('.document-tab').count(), 2);
  await tab(a); assert.match(await page.locator('#source-editor').innerText(), /A source edit/);
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${modifier}+z`);
  assert.doesNotMatch(await page.locator('#source-editor').innerText(), /A source edit/);
  await page.keyboard.press(redo); assert.match(await page.locator('#source-editor').innerText(), /A source edit/);
  await tab(b); assert.match(await page.locator('#source-editor').innerText(), /B unsaved edit/);
  pass('source tabs retain independent unsaved text, selection and undo/redo');

  await tab(a); await page.locator('[data-mode="visual"]').click();
  await page.locator('.ProseMirror > p').last().click(); await page.keyboard.press(end); await page.keyboard.insertText(' Rich token');
  await tab(b); await tab(a); await page.locator('.ProseMirror').click(); await page.keyboard.press(`${modifier}+z`);
  assert.doesNotMatch(await page.locator('.ProseMirror').innerText(), /Rich token/); assert.match(await page.locator('.ProseMirror').innerText(), /A source edit/);
  await action('save'); assert.ok((await fs.readFile(a, 'utf8')).startsWith('\uFEFF# Alpha\r\n'));
  await tab(b); await open(b); assert.equal(await page.locator('.document-tab').count(), 2); assert.match(await page.locator('#source-editor').innerText(), /B unsaved edit/);
  pass('rich editor undo survives tab switches; reopening the same file selects its existing dirty tab');

  const beforeA = await fs.readFile(a); await setting('MOYE_TEST_SAVE_PATH', a); await action('saveAs');
  assert.deepEqual(await fs.readFile(a), beforeA); assert.match(await page.locator('#toast').innerText(), /另一个标签/);
  await setting('MOYE_TEST_SAVE_DELAY', '1200');
  await page.locator('[data-action="save"]').first().evaluate(button => button.click());
  await poll(() => app.evaluate(() => process.env.MOYE_TEST_SAVE_PENDING === '1'));
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(end); await page.keyboard.insertText(' Later keystrokes'); await idle();
  assert.doesNotMatch(await fs.readFile(b, 'utf8'), /Later keystrokes/); assert.equal(await page.locator('#dirty-dot').isVisible(), true);
  await setting('MOYE_TEST_SAVE_DELAY', '0'); await action('save'); assert.match(await fs.readFile(b, 'utf8'), /Later keystrokes/);
  pass('Save As rejects another open tab and asynchronous saves do not mark later input as saved');

  await append('\nClose confirmation'); await closeTab(); assert.equal(await page.locator('.document-tab').count(), 2); assert.equal(await page.locator('#dirty-dot').isVisible(), true);
  await setting('MOYE_TEST_DISCARD', 'save'); await closeTab(); assert.equal(await page.locator('.document-tab').count(), 1); assert.match(await fs.readFile(b, 'utf8'), /Close confirmation/);
  await open(b); await tab(a); await append('\nDefault autosave stays off'); await page.waitForTimeout(800);
  assert.doesNotMatch(await fs.readFile(a, 'utf8'), /Default autosave stays off/);
  pass('individual close respects cancel/save; recovery snapshots do not write Markdown while autosave is off');

  await lifecycleSettings({ autoSave: true, autoSaveInterval: 10 }); await append('\nAutomatic writeback');
  await poll(async () => (await fs.readFile(a, 'utf8')).includes('Automatic writeback'));
  await idle(); assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  assert.ok((await page.evaluate(file => window.moye.listVersions(file), a)).length >= 2);
  pass('opt-in interval autosave writes saved documents and preserves their previous versions');

  const savedA = await fs.readFile(a);
  await append('\nBackground conflicting edit'); await tab(b); await fs.writeFile(a, 'External bytes must survive');
  await setting('MOYE_TEST_CONFLICT', 'overwrite');
  await poll(() => page.locator('.document-tab').filter({ has: page.locator(`[title="${a.replace(/\\/g, '\\\\')}"]`) }).locator('.tab-paused').count().then(count => count > 0));
  await page.waitForTimeout(11000); assert.equal(await fs.readFile(a, 'utf8'), 'External bytes must survive');
  await tab(a); assert.match(await page.locator('#source-editor').innerText(), /Background conflicting edit/); assert.match(await page.locator('#document-state').innerText(), /暂停/);
  pass('external changes in inactive tabs pause autosave without conflict dialogs or repeated overwrites');

  await fs.writeFile(a, savedA);
  await poll(() => page.locator('.document-tab.active .tab-paused').count().then(count => count === 0));
  await poll(async () => (await fs.readFile(a, 'utf8')).includes('Background conflicting edit'));
  pass('restoring the exact saved disk version clears only the external pause and resumes safe autosave');

  await tab(b); const diskB = await fs.readFile(b);
  await append('\nUnsaved before history restore'); await setting('MOYE_TEST_DISCARD', 'cancel');
  await action('history'); await page.locator('#history-list button').last().click(); await page.locator('#restore-version').waitFor({ state: 'visible' });
  await poll(() => page.locator('#restore-version').isEnabled());
  const restored = await page.locator('#history-preview').inputValue();
  await page.screenshot({ path: path.join(run, 'history.png'), animations: 'disabled' });
  await page.locator('#restore-version').click(); await idle();
  assert.equal(await page.locator('#history-dialog').isVisible(), true);
  assert.match(await page.locator('#source-editor').innerText(), /Unsaved before history restore/);
  await setting('MOYE_TEST_DISCARD', 'discard'); await page.locator('#restore-version').click(); await idle(); await source();
  assert.equal(await page.locator('#source-editor .cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n')), restored);
  assert.equal(await page.locator('#dirty-dot').isVisible(), true); assert.match(await page.locator('#document-state').innerText(), /手动保存/);
  await page.waitForTimeout(11000); assert.deepEqual(await fs.readFile(b), diskB);
  const historical = JSON.parse(await fs.readFile(path.join(profile, 'session.json'), 'utf8')).documents.find(doc => doc.path === b);
  const blocked = await page.evaluate(doc => window.moye.autoSaveDocument({ ...doc, tabId: doc.id }), historical);
  assert.equal(blocked.status, 'paused'); assert.deepEqual(await fs.readFile(b), diskB);
  await action('save'); assert.equal(await fs.readFile(b, 'utf8'), restored);
  pass('version previews restore only to a dirty buffer and stay paused until an explicit manual save');

  await lifecycleSettings({ autoSave: false }); await action('folder');
  await append('\nB before workspace operation'); await tab(a); await append('\nA before workspace operation');
  await menu(notes, 'rename'); await page.locator('#workspace-entry-name').fill('moved'); await page.locator('#workspace-form button[type="submit"]').click(); await idle();
  const moved = path.join(folder, 'moved'); a = path.join(moved, 'Alpha.md'); b = path.join(moved, 'Beta.md');
  await tab(b); assert.match(await page.locator('#source-editor').innerText(), /B before workspace operation/); assert.equal(await page.locator('#dirty-dot').isVisible(), true);
  assert.ok((await page.evaluate(file => window.moye.listVersions(file), b)).length);
  await setting('MOYE_TEST_TRASH', 'confirm'); await menu(moved, 'trash');
  assert.equal(await fs.stat(moved).catch(() => null), null); assert.equal(await page.locator('.document-tab .tab-dirty.visible').count(), 2);
  assert.equal(await page.locator('#document-name').getAttribute('title'), '尚未保存到文件');
  const session = JSON.parse(await fs.readFile(path.join(profile, 'session.json'), 'utf8'));
  assert.ok(session.documents.every(doc => doc.path === null && doc.dirty));
  pass('workspace parent rename migrates every tab and history; trash preserves all open buffers as unsaved documents');

  await setting('MOYE_TEST_DISCARD', 'cancel'); await action('close-all'); assert.equal(await page.locator('.document-tab').count(), 2);
  await setting('MOYE_TEST_DISCARD', 'discard'); await action('close-all'); assert.equal(await page.locator('.document-tab').count(), 1);
  await append('Crash draft one α'); await action('new'); await append('Crash draft two β');
  assert.equal(await page.locator('#document-name').textContent(), '未命名 2.md');
  await lifecycleSettings({ reopenSession: false }); await page.waitForTimeout(900); await crash(); await launch();
  assert.equal(await page.locator('.document-tab').count(), 2); assert.equal(await page.locator('#recovery-banner').isVisible(), true);
  await source(); assert.match(await page.locator('#source-editor').innerText(), /Crash draft two/);
  await page.locator('.document-tab [role="tab"]').first().click(); await idle(); await source(); assert.match(await page.locator('#source-editor').innerText(), /Crash draft one/);
  await page.screenshot({ path: path.join(run, 'recovered-tabs.png'), animations: 'disabled' });
  pass('close-all cancel retains every tab; crashes recover all dirty documents even with reopen-last-session disabled');

  await setting('MOYE_TEST_DISCARD', 'discard'); await action('close-all');
  const c = path.join(folder, 'Clean.md'), d = path.join(folder, 'Other.md'); await fs.writeFile(c, '# Clean'); await fs.writeFile(d, '# Other');
  await open(c); await open(d); await lifecycleSettings({ reopenSession: true }); await normalQuit();
  await fs.writeFile(c, '# Fresh external content'); await launch();
  assert.equal(await page.locator('.document-tab').count(), 2); assert.equal(await page.locator('#document-name').textContent(), 'Other.md');
  await tab(c); assert.match(await page.locator('.ProseMirror').innerText(), /Fresh external content/); assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  await lifecycleSettings({ reopenSession: false }); await normalQuit(); await launch();
  assert.equal(await page.locator('.document-tab').count(), 1); assert.equal(await page.locator('#document-name').textContent(), '开始写作.md'); assert.equal(await page.locator('#recovery-banner').isVisible(), false);
  pass('normal close/reopen restores the last clean session using fresh disk bytes; the reopen switch disables it');

  const rejected = await page.evaluate(async path => {
    const failures = [];
    for (const call of [() => window.moye.listVersions(path), () => window.moye.readVersion(path, '../bad'), () => window.moye.saveSession({ documents: [{ path, name: 'outside.md', content: 'bad', revision: null, id: 'bad', dirty: true, mode: 'source', paused: null }], activeId: 'bad' }), () => window.moye.updateSettings({ autoSaveInterval: 1 })]) {
      try { await call(); failures.push(false); } catch { failures.push(true); }
    }
    return failures;
  }, path.join(run, 'unauthorized.md'));
  assert.deepEqual(rejected, [true, true, true, true]); assert.deepEqual(errors, []);
  pass('lifecycle IPC rejects unauthorized history/session paths and invalid settings; no renderer exceptions');
} finally {
  if (page && app) { await page.screenshot({ path: path.join(run, 'last-state.png'), animations: 'disabled', timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); }
  await crash(); await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

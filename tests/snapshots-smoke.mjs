import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'snapshots-')));
const profile = path.join(run, 'profile'), file = path.join(run, '原稿.md'), savedDraft = path.join(run, '保存的草稿.md');
await fs.mkdir(profile);
await fs.writeFile(file, '\uFEFF# 原稿\r\n\r\n初始正文\r\n');
await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { autoSave: false, autoSaveInterval: 2, autoSaveOnBlur: false, autoSnapshot: false, snapshotInterval: 10 } }));
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'discard', MOYE_TEST_CONFLICT: 'cancel', MOYE_TEST_SAVE_PATH: savedDraft };
delete env.ELECTRON_RUN_AS_NODE;
const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
let app, page;
const results = [], errors = [];
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function poll(check, timeout = 16000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Timed out waiting for autosave/snapshot state');
}
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await idle(); }
async function sourceText() { return page.locator('#source-editor .cm-line').evaluateAll(lines => lines.map(node => node.textContent).join('\n')); }
async function append(text) {
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(end); await page.keyboard.insertText(text);
  await poll(async () => (await sourceText()).includes(text));
}
async function settings(patch) {
  await page.locator('.tab-settings').click();
  const selectors = { autoSave: '#auto-save', autoSaveOnBlur: '#auto-save-blur', autoSnapshot: '#auto-snapshot', autoSaveInterval: '#auto-save-interval', snapshotInterval: '#snapshot-interval' };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'boolean') await page.locator(selectors[key]).setChecked(value);
    else await page.locator(selectors[key]).selectOption(String(value));
    await poll(() => page.evaluate(async ({ key, value }) => (await window.moye.boot()).settings[key] === value, { key, value }));
    await idle();
  }
  await page.locator('.tab-settings').click();
}
async function session() { return JSON.parse(await fs.readFile(path.join(profile, 'session.json'), 'utf8')); }
async function active() { const data = await session(); return data.documents.find(doc => doc.id === data.activeId); }
async function snapshots() { return page.evaluate(() => window.moye.listSnapshots()); }
async function openSnapshots() { await action('snapshots'); await poll(async () => !((await page.locator('#snapshot-status').innerText()).includes('正在读取'))); }
async function closeSnapshots() { await page.locator('#close-snapshots').click(); await page.locator('#snapshot-dialog').waitFor({ state: 'hidden' }); }
async function createNamed(label) {
  await openSnapshots(); await page.locator('#snapshot-label').fill(label); await page.locator('#snapshot-create button').click();
  await poll(async () => (await page.locator('#snapshot-status').innerText()).includes('快照已保存'));
  await idle();
  return (await snapshots()).find(item => item.label === label);
}
async function select(id) {
  await page.locator(`[data-snapshot-id="${id}"]`).click();
  await poll(() => page.locator('#copy-snapshot').isEnabled());
}
async function launch(args = []) {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
  await page.waitForSelector('#shell[data-ready="true"]');
}
async function crash() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
try {
  await launch(['--open', file]);
  await openSnapshots();
  await page.evaluate(() => {
    document.querySelector('#close-snapshots').click();
    document.querySelector('[data-action="snapshots"]').click();
  });
  await poll(async () => await page.locator('#snapshot-dialog').isVisible() && !(await page.locator('#snapshot-status').innerText()).includes('正在读取'));
  await closeSnapshots();
  pass('a queued close event cannot invalidate a newly reopened snapshot dialog');
  await action('toggle-autosave'); await poll(() => page.locator('#toggle-autosave').getAttribute('aria-pressed').then(value => value === 'true'));
  const menu = await app.evaluate(({ Menu }) => {
    const visit = items => items.flatMap(item => [{ label: item.label, checked: item.checked }, ...visit(item.submenu?.items || [])]);
    return visit(Menu.getApplicationMenu().items);
  });
  assert.equal(menu.find(item => item.label === '自动保存').checked, true); assert.ok(menu.some(item => item.label === '快照…'));
  await page.locator('.tab-settings').click();
  await page.evaluate(() => {
    for (const [selector, values] of [['#auto-save-blur', [true, false]], ['#auto-snapshot', [true, false]]]) {
      for (const value of values) { const input = document.querySelector(selector); input.checked = value; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const interval = document.querySelector('#auto-save-interval'); interval.value = '10'; interval.dispatchEvent(new Event('change', { bubbles: true }));
    interval.value = '5'; interval.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await poll(() => page.evaluate(async () => {
    const settings = (await window.moye.boot()).settings;
    return !settings.autoSaveOnBlur && !settings.autoSnapshot && settings.autoSaveInterval === 5;
  }));
  await page.locator('.tab-settings').click();
  await settings({ autoSaveInterval: 2 });
  await append('\n第一段'); await page.waitForTimeout(1100); await append('\n第二段'); await page.waitForTimeout(1100);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /第一段/);
  await poll(async () => (await fs.readFile(file, 'utf8')).includes('第二段'));
  await idle(); assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  assert.ok((await fs.readFile(file, 'utf8')).startsWith('\uFEFF# 原稿\r\n'));
  assert.ok((await page.evaluate(file => window.moye.listVersions(file), file)).length);
  pass('one-click autosave waits for the last edit and preserves BOM/CRLF and pre-save history');

  await page.locator('#document-scroll').dispatchEvent('compositionstart');
  await append('\n输入法组合期间'); await page.waitForTimeout(3100);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /输入法组合期间/);
  await page.locator('#document-scroll').dispatchEvent('compositionend');
  await poll(async () => (await fs.readFile(file, 'utf8')).includes('输入法组合期间')); await idle();
  pass('IME composition suppresses automatic writes until composition finishes');

  await settings({ autoSaveInterval: 60, autoSaveOnBlur: true }); await append('\n离开窗口保存');
  // Windows can immediately re-focus the sole visible window after blur(); hiding it causes a real focus loss.
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForFunction(() => document.hasFocus());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await poll(async () => (await fs.readFile(file, 'utf8')).includes('离开窗口保存'), 6000); await idle();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
  await settings({ autoSaveInterval: 2, autoSaveOnBlur: false });
  pass('leaving the native window saves eligible tabs before their configured idle delay');

  await fs.writeFile(file, '外部修改不得覆盖'); await append('\n快照原始内容');
  await poll(() => page.locator('#document-state').innerText().then(text => text.includes('暂停')));
  const checkpoint = await createNamed('改写前 <img onerror=alert(1)>');
  assert.equal(await page.locator('#snapshot-list img').count(), 0);
  assert.equal(await fs.readFile(file, 'utf8'), '外部修改不得覆盖');
  await select(checkpoint.id); assert.match(await page.locator('#snapshot-preview').inputValue(), /快照原始内容/);
  await page.screenshot({ path: path.join(run, 'snapshot-preview.png'), animations: 'disabled' });
  await closeSnapshots();
  pass('named snapshots capture the unsaved buffer without writing external changes or interpreting labels as HTML');

  await append('\n恢复前不能丢失'); await openSnapshots(); await select(checkpoint.id);
  await page.locator('#restore-snapshot').click(); await page.locator('#snapshot-dialog').waitFor({ state: 'hidden' }); await idle();
  assert.doesNotMatch(await sourceText(), /恢复前不能丢失/);
  const backup = (await snapshots()).find(item => item.kind === 'restore');
  assert.match((await page.evaluate(id => window.moye.readSnapshot(id), backup.id)).content, /恢复前不能丢失/);
  await page.waitForTimeout(3100); assert.equal(await fs.readFile(file, 'utf8'), '外部修改不得覆盖');
  assert.match(await page.locator('#document-state').innerText(), /手动保存/);
  pass('restoring creates a durable pre-restore snapshot and pauses writeback without overwriting disk');

  await openSnapshots(); await select(checkpoint.id); await page.locator('#copy-snapshot').click();
  await page.locator('#snapshot-dialog').waitFor({ state: 'hidden' }); await idle();
  assert.equal(await page.locator('.document-tab').count(), 2);
  assert.equal((await active()).path, null); assert.equal(await page.locator('#dirty-dot').isVisible(), true);
  await append('\n定期保留未命名内容'); await settings({ autoSnapshot: true });
  const untitled = await active();
  await poll(async () => (await snapshots()).some(item => item.tabId === untitled.id && item.kind === 'auto'), 18000);
  const automatic = (await snapshots()).find(item => item.tabId === untitled.id && item.kind === 'auto');
  assert.match((await page.evaluate(id => window.moye.readSnapshot(id), automatic.id)).content, /定期保留未命名内容/);
  await page.waitForTimeout(11000);
  assert.equal((await snapshots()).filter(item => item.tabId === untitled.id).length, 1);
  assert.equal(await fs.stat(savedDraft).catch(() => null), null);
  await settings({ autoSnapshot: false });
  pass('opening a snapshot as a new draft preserves other tabs; timed snapshots retain untitled edits and deduplicate unchanged content');

  const namedDraft = await createNamed('草稿检查点'); await closeSnapshots(); await action('save');
  await poll(async () => (await active()).path === savedDraft);
  assert.equal((await snapshots()).find(item => item.id === namedDraft.id).path, savedDraft);
  await openSnapshots(); assert.equal(await page.locator(`[data-snapshot-id="${automatic.id}"]`).count(), 1); await closeSnapshots();
  pass('first Save As moves both manual and automatic draft snapshots to the saved document');

  await action('new'); await append('关闭后还要找回');
  const closedDraft = await createNamed('归档的未命名文稿'); await closeSnapshots();
  await page.locator('.document-tab.active .close-document-tab').click(); await idle();
  await openSnapshots(); await page.locator('#snapshot-scope').selectOption('all');
  await page.locator(`[data-snapshot-id="${closedDraft.id}"]`).waitFor(); await select(closedDraft.id);
  assert.equal(await page.locator('#restore-snapshot').isEnabled(), false);
  await page.locator('#copy-snapshot').click(); await page.locator('#snapshot-dialog').waitFor({ state: 'hidden' }); await idle();
  await page.locator('[data-mode="source"]').click(); assert.equal(await sourceText(), '关闭后还要找回');
  pass('all-document library retains snapshots of closed untitled drafts and opens them without changing another file');

  await openSnapshots(); await page.locator('#snapshot-scope').selectOption('all'); await select(closedDraft.id);
  await page.locator('#delete-snapshot').click(); await idle(); assert.ok((await snapshots()).some(item => item.id === closedDraft.id));
  await app.evaluate(() => { process.env.MOYE_TEST_DELETE_SNAPSHOT = 'confirm'; });
  await page.locator('#delete-snapshot').click(); await poll(async () => !(await snapshots()).some(item => item.id === closedDraft.id)); await idle();
  await closeSnapshots(); assert.equal(await sourceText(), '关闭后还要找回');
  pass('deletion requires an explicit confirmation and leaves the current document unchanged');

  const rejected = await page.evaluate(async outside => {
    const input = { path: null, name: 'bad.md', content: 'bad', revision: null, tabId: 'unknown', kind: 'manual' };
    const results = [];
    for (const call of [() => window.moye.createSnapshot(input), () => window.moye.createSnapshot({ ...input, path: outside }), () => window.moye.readSnapshot('../index.json'), () => window.moye.updateSettings({ snapshotInterval: 1 })]) {
      try { await call(); results.push(false); } catch { results.push(true); }
    }
    return results;
  }, path.join(run, 'unauthorized.md'));
  assert.deepEqual(rejected, [true, true, true, true]);
  pass('snapshot IPC rejects nonexistent tabs, unauthorized paths, traversal and invalid intervals');

  await page.waitForTimeout(800); await crash(); await launch();
  assert.equal((await page.evaluate(() => window.moye.boot())).settings.autoSave, true);
  assert.equal((await page.evaluate(() => window.moye.boot())).settings.autoSnapshot, false);
  await openSnapshots(); await page.locator('#snapshot-scope').selectOption('all'); await select(namedDraft.id);
  assert.match(await page.locator('#snapshot-preview').inputValue(), /定期保留未命名内容/);
  await page.screenshot({ path: path.join(run, 'snapshot-library.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  pass('snapshot library and autosave preferences survive process restart without renderer errors');

  await closeSnapshots();
  const kept = await createNamed('恢复失败也要保留'); await closeSnapshots(); await append('\n这些新输入不能丢');
  await poll(async () => (await active()).content.includes('这些新输入不能丢'));
  const before = await active();
  await page.evaluate(async doc => {
    for (let i = 0; i < 19; i++) await window.moye.createSnapshot({ ...doc, tabId: doc.id, kind: 'manual', label: `保留 ${i}` });
  }, before);
  await openSnapshots(); await select(kept.id); await page.locator('#restore-snapshot').click();
  await poll(() => page.locator('#snapshot-status').innerText().then(text => text.includes('空间已满'))); await idle();
  assert.doesNotMatch(await page.locator('#snapshot-status').innerText(), /Error invoking|moye:create-snapshot/);
  assert.equal(await sourceText(), before.content);
  assert.equal((await snapshots()).filter(item => item.path === null && item.tabId === before.id).length, 20);
  assert.equal(await page.locator('#snapshot-dialog').isVisible(), true);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].unmaximize(); BrowserWindow.getAllWindows()[0].setSize(800, 600); });
  await page.screenshot({ path: path.join(run, 'compact-snapshots.png'), animations: 'disabled' });
  const bounds = await page.locator('#snapshot-dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0);
  await page.locator('#close-snapshots').click();
  assert.deepEqual(errors, []);
  pass('a full manual-snapshot quota stops restoration before replacing current input; the dialog remains usable in a compact window');
} finally {
  if (page && app) {
    await page.screenshot({ path: path.join(run, 'last-state.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
    await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => ''));
  }
  await crash(); await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

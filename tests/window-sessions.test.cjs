'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileStore, pathKey } = require('../electron/file-store.cjs');
const { LifecycleStore } = require('../electron/lifecycle-store.cjs');
const { WindowSessions, validateWindows, MAX_WINDOWS } = require('../electron/window-sessions.cjs');

const entry = (id, content = id, file = null) => ({ id, name: `${id}.md`, path: file, content, revision: null, dirty: true, mode: 'source', paused: null });
const session = (...documents) => ({ documents, activeId: documents[0]?.id || null });
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'moye-windows-')));
  t.after(async () => { const real = await fs.realpath(root); assert.equal(pathKey(path.dirname(real)), pathKey(parent)); assert.ok(path.basename(real).startsWith('moye-windows-')); await fs.rm(real, { recursive: true, force: true }); });
  const store = new FileStore(path.join(root, 'profile')); await store.init();
  const history = new LifecycleStore(store); await history.init();
  const windows = new WindowSessions(store, history); await windows.init();
  return { root, store, history, windows };
}

test('window sessions migrate legacy dirty documents and keep a compatible primary recovery copy', async t => {
  const { store, history } = await fixture(t);
  await history.saveSession(session(entry('old', '\uFEFF---\r\ntitle: 旧稿\r\n---\r\n')));
  const windows = new WindowSessions(store, history); await windows.init();
  const restored = await windows.startup(false);
  assert.equal(restored.length, 1); assert.equal(restored[0].session.documents[0].paused, 'recovered');
  assert.equal(restored[0].session.documents[0].content, history.session.documents[0].content);
  await windows.save('main', session(entry('old', 'new text')));
  assert.equal(JSON.parse(await fs.readFile(history.sessionPath, 'utf8')).documents[0].content, 'new text');
});

test('simultaneous saves retain every window and isolate active tabs, folders and bounds', async t => {
  const { windows, root, store, history } = await fixture(t);
  const second = await windows.add({ workspaceRoot: root, bounds: { x: 20, y: 40, width: 800, height: 600, maximized: false } });
  await Promise.all([windows.save('main', session(entry('a'))), windows.save(second, session(entry('b')))]);
  const reopened = new WindowSessions(store, history); await reopened.init();
  assert.equal(reopened.get('main').session.activeId, 'a'); assert.equal(reopened.get(second).session.activeId, 'b');
  assert.equal(reopened.get(second).workspaceRoot, root); assert.equal(reopened.get(second).bounds.width, 800);
  assert.equal(reopened.get('main').workspaceRoot, null);
});

test('global ownership rejects duplicate paths and tab identities without overwriting the persisted sessions', async t => {
  const { windows, root } = await fixture(t); const second = await windows.add();
  const file = path.join(root, 'a.md'); await windows.save('main', session(entry('a', 'keep', file)));
  const before = await fs.readFile(windows.filename);
  await assert.rejects(windows.save(second, session(entry('b', 'other', file))), /其他窗口/);
  await assert.rejects(windows.save(second, session(entry('a', 'collision'))), /其他窗口/);
  assert.deepEqual(await fs.readFile(windows.filename), before);
  assert.throws(() => windows.facade(second).assertSaveTarget(file, 'b'), /另一个窗口/);
});

test('window count, aggregate recovery size and catalog metadata are bounded', async t => {
  const { windows } = await fixture(t);
  for (let i = 1; i < MAX_WINDOWS; i++) await windows.add();
  await assert.rejects(windows.add(), /8/);
  assert.throws(() => validateWindows([{ id: '../escape', session: null }]), /窗口/);
  assert.throws(() => validateWindows([{ id: 'one', session: null, workspaceRoot: '../outside' }]));
  assert.throws(() => validateWindows([{ id: 'one', session: null, bounds: { x: 0, y: 0, width: Infinity, height: 500, maximized: false } }]));
  const large = 'a'.repeat(16 * 1024 * 1024);
  assert.throws(() => validateWindows(Array.from({ length: 3 }, (_, window) => ({ id: `win${window}`, session: session(...Array.from({ length: 3 }, (_, tab) => entry(`${window}-${tab}`, large))) }))), /128 MiB/);
});

test('transferring a dirty tab commits one owner atomically and retains text, identity, mode and pause reason', async t => {
  const { windows, root } = await fixture(t); const target = await windows.add();
  const doc = { ...entry('move', 'unsaved $x$\n', path.join(root, 'a.md')), paused: 'external' };
  await windows.save('main', session(doc, entry('stay')));
  await windows.transfer('main', target, doc.id);
  const saved = JSON.parse(await fs.readFile(windows.filename, 'utf8')).windows;
  assert.equal(saved.flatMap(record => record.session?.documents || []).filter(item => item.id === doc.id).length, 1);
  assert.deepEqual(windows.get(target).session.documents[0], { ...doc, name: 'a.md' });
  assert.equal(windows.get('main').session.activeId, 'stay');
  await windows.rollbackTransfer('main', target);
  assert.equal(windows.records.length, 1); assert.equal(windows.get('main').session.activeId, 'move');
  assert.equal(windows.get('main').session.documents[1].content, doc.content);
});

test('a failed authoritative write preserves the original catalog and in-memory document ownership', async t => {
  const { windows } = await fixture(t); const target = await windows.add(); await windows.save('main', session(entry('move')));
  const before = await fs.readFile(windows.filename), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === windows.filename) throw new Error('simulated disk failure'); return rename(from, to); };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(windows.transfer('main', target, 'move'), /disk failure/);
  assert.deepEqual(await fs.readFile(windows.filename), before);
  assert.equal(windows.get('main').session.documents[0].id, 'move'); assert.equal(windows.get(target).session, null);
});

test('a compatibility-copy failure does not turn a committed transfer into an apparent failure', async t => {
  const { windows, history, store } = await fixture(t); const target = await windows.add(); await windows.save('main', session(entry('move')));
  history.saveSession = async () => { throw new Error('legacy copy unavailable'); };
  await windows.transfer('main', target, 'move');
  assert.equal(windows.get(target).session.documents[0].id, 'move'); assert.match(windows.warning, /兼容/);
  const reopened = new WindowSessions(store, history); await reopened.init(); assert.equal(reopened.get(target).session.documents[0].id, 'move');
});

test('quit staging leaves originals recoverable until all windows approve and commits closed sessions together', async t => {
  const { windows } = await fixture(t); const second = await windows.add();
  await windows.save('main', session(entry('keep'))); await windows.save(second, session(entry('other')));
  const staged = new Map([['main', session()], [second, session()]]);
  const before = JSON.parse(await fs.readFile(windows.filename, 'utf8'));
  assert.equal(before.windows[0].session.documents[0].content, 'keep');
  await windows.finishClose(staged);
  assert.ok(windows.records.every(record => record.session.cleanExit && !record.session.documents.length));
});

test('crash recovery reopens all dirty windows even with session reopening disabled, while clean windows can stay closed', async t => {
  const { windows, store, history, root } = await fixture(t); const second = await windows.add();
  await windows.save('main', session(entry('a'))); await windows.save(second, session(entry('b')));
  const reopened = new WindowSessions(store, history); await reopened.init(); const records = await reopened.startup(false);
  assert.equal(records.length, 2); assert.ok(records.every(record => record.session.documents[0].paused === 'recovered'));
  const file = path.join(root, 'fresh.md'); await fs.writeFile(file, 'fresh disk text');
  await reopened.save('main', session({ ...entry('a', 'stale', file), dirty: false }));
  await reopened.clean(['main']); await reopened.remove(second);
  const fresh = await reopened.startup(true); assert.equal(fresh[0].session.documents[0].content, 'fresh disk text');
  await reopened.clean(['main']); const disabled = await reopened.startup(false); assert.equal(disabled[0].session, null);
});

test('corrupt catalogs are backed up before replacement and linked catalogs are rejected', async t => {
  const { windows, store, history, root } = await fixture(t);
  await history.saveSession(session(entry('legacy')));
  await fs.writeFile(windows.filename, '{broken');
  const repaired = new WindowSessions(store, history); await repaired.init(); await repaired.startup(false);
  const backup = (await fs.readdir(store.userData)).find(file => file.startsWith('windows-corrupt-'));
  assert.equal(await fs.readFile(path.join(store.userData, backup), 'utf8'), '{broken');
  assert.equal(repaired.get('main').session.documents[0].id, 'legacy');
  await fs.unlink(windows.filename); const outside = path.join(root, 'external.json'); await fs.writeFile(outside, '{}'); await fs.link(outside, windows.filename);
  await assert.rejects(new WindowSessions(store, history).init(), /普通文件/); assert.equal(await fs.readFile(outside, 'utf8'), '{}');
});

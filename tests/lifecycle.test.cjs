'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { FileStore, DEFAULT_SETTINGS, validateSettings, RevisionConflictError } = require('../electron/file-store.cjs');
const { LifecycleStore, validateSession, MAX_TABS, MAX_SESSION_BYTES } = require('../electron/lifecycle-store.cjs');

async function fixture(t, limits) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moye-lifecycle-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileStore(path.join(root, 'profile')); await store.init();
  const lifecycle = new LifecycleStore(store, limits); await lifecycle.init();
  const file = path.join(root, '文稿.md'); await fs.writeFile(file, '\uFEFF# 初稿\r\n\r\nαβ\r\n');
  const doc = await store.readDocument(file);
  const entry = { ...doc, id: crypto.randomUUID(), dirty: false, mode: 'source', paused: null };
  return { root, store, lifecycle, file, doc, entry };
}

test('lifecycle settings migrate to disabled autosave and validate safe intervals', () => {
  assert.equal(DEFAULT_SETTINGS.autoSave, false); assert.equal(DEFAULT_SETTINGS.autoSaveInterval, 30); assert.equal(DEFAULT_SETTINGS.reopenSession, true);
  assert.equal(validateSettings({ autoSave: true, autoSaveInterval: 600, reopenSession: false }).autoSaveInterval, 600);
  for (const input of [{ autoSave: 1 }, { autoSaveInterval: 0 }, { autoSaveInterval: 1 }, { autoSaveInterval: 601 }, { autoSaveInterval: 30.5 }, { reopenSession: 'yes' }]) assert.throws(() => validateSettings(input), /Invalid setting/);
});

test('session validation rejects duplicate documents, IDs, invalid paths, revisions and bounded payloads', async t => {
  const { entry } = await fixture(t); const session = { documents: [entry], activeId: entry.id };
  assert.deepEqual(validateSession(session), session);
  for (const patch of [{ path: '../escape.md' }, { revision: 'x' }, { id: '../bad' }, { dirty: 1 }, { mode: 'unknown' }, { paused: 'enabled' }, { content: 'a\0b' }]) assert.throws(() => validateSession({ ...session, documents: [{ ...entry, ...patch }] }));
  assert.throws(() => validateSession({ ...session, activeId: 'missing' }));
  assert.throws(() => validateSession({ ...session, documents: [entry, { ...entry, id: 'other' }] }), /two tabs/);
  assert.throws(() => validateSession({ ...session, documents: Array.from({ length: MAX_TABS + 1 }, (_, n) => ({ ...entry, id: String(n), path: null })) }), /24/);
  const content = 'a'.repeat(MAX_SESSION_BYTES / 4 + 1);
  assert.throws(() => validateSession({ activeId: '0', documents: Array.from({ length: 4 }, (_, n) => ({ ...entry, path: null, id: String(n), content })) }), /48 MiB/);
});

test('crashed multi-document session recovers dirty text even with reopen disabled, without overwriting external bytes', async t => {
  const { lifecycle, store, entry, file } = await fixture(t);
  const draft = { ...entry, content: '# 我的未保存修改\n', dirty: true };
  const untitled = { ...entry, id: 'untitled', path: null, revision: null, name: '未命名.md', content: '$x^2$\n', dirty: true };
  await lifecycle.saveSession({ documents: [draft, untitled], activeId: untitled.id });
  await fs.writeFile(file, '外部版本');
  const reopened = new LifecycleStore(store); await reopened.init();
  const restored = await reopened.restore(false);
  assert.equal(restored.recovered, true); assert.equal(restored.activeId, 'untitled'); assert.equal(restored.documents.length, 2);
  assert.equal(restored.documents[0].content, draft.content); assert.equal(restored.documents[0].revision, entry.revision); assert.equal(restored.documents[0].paused, 'recovered');
  assert.equal(await fs.readFile(file, 'utf8'), '外部版本');
});

test('clean sessions reopen fresh disk content only when enabled and retain BOM/EOL conventions', async t => {
  const { lifecycle, store, entry, file } = await fixture(t);
  await lifecycle.saveSession({ documents: [entry], activeId: entry.id }); await lifecycle.markClean();
  await fs.writeFile(file, '\uFEFF# 新的磁盘版本\r\n');
  assert.equal((await lifecycle.restore(false)).documents.length, 0);
  const restored = await lifecycle.restore(true);
  assert.equal(restored.recovered, false); assert.equal(restored.documents[0].content, '# 新的磁盘版本\n');
  await store.saveDocument({ ...restored.documents[0], content: '# 已编辑\n' });
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF# 已编辑\r\n');
});

test('ordered session writes and workspace rename/trash retain every unsaved buffer', async t => {
  const { lifecycle, entry, root } = await fixture(t);
  await Promise.all([lifecycle.saveSession({ documents: [entry], activeId: entry.id }), lifecycle.saveSession({ documents: [{ ...entry, dirty: true, content: 'last' }], activeId: entry.id })]);
  const renamed = path.join(root, 'moved.md');
  await Promise.all([lifecycle.saveSession({ documents: [{ ...entry, dirty: true, content: 'newest pending write' }], activeId: entry.id }), lifecycle.remapSession(entry.path, renamed)]);
  assert.equal(lifecycle.session.documents[0].path, renamed); assert.equal(lifecycle.session.documents[0].content, 'newest pending write');
  await lifecycle.remapSession(renamed, null);
  assert.equal(lifecycle.session.documents[0].path, null); assert.equal(lifecycle.session.documents[0].revision, null); assert.equal(lifecycle.session.documents[0].dirty, true);
});

test('unreadable sessions are backed up byte-for-byte before replacement; backup failure retains the original', async t => {
  const { store, entry } = await fixture(t);
  const sessionPath = path.join(store.userData, 'session.json'), corrupted = Buffer.from('{"documents":["damaged but recoverable α');
  await fs.writeFile(sessionPath, corrupted);
  const lifecycle = new LifecycleStore(store); await lifecycle.init();
  const copyFile = fs.copyFile;
  fs.copyFile = async () => { throw Error('simulated full recovery volume'); };
  try { await assert.rejects(lifecycle.saveSession({ documents: [entry], activeId: entry.id }), /无法备份/); }
  finally { fs.copyFile = copyFile; }
  assert.deepEqual(await fs.readFile(sessionPath), corrupted);
  await lifecycle.saveSession({ documents: [entry], activeId: entry.id });
  const backups = (await fs.readdir(store.userData)).filter(name => name.startsWith('session-corrupt-'));
  assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(store.userData, backups[0])), corrupted);
  assert.equal(JSON.parse(await fs.readFile(sessionPath, 'utf8')).documents[0].id, entry.id);
  await lifecycle.saveSession({ documents: [], activeId: null });
  assert.deepEqual(await fs.readFile(path.join(store.userData, backups[0])), corrupted);
});

test('saving records exact previous BOM/CRLF bytes, skips unchanged content and never writes during history reads', async t => {
  const { lifecycle, store, doc, file } = await fixture(t);
  const original = await fs.readFile(file);
  const beforeReplace = (file, bytes) => lifecycle.record(file, bytes);
  await store.saveDocument(doc, { beforeReplace }); assert.equal(lifecycle.list(file).length, 0);
  const saved = await store.saveDocument({ ...doc, content: '# 二稿\n' }, { beforeReplace });
  const versions = lifecycle.list(file); assert.equal(versions.length, 1); assert.equal(versions[0].revision, doc.revision);
  const blob = lifecycle.history[0].versions[0].blob; assert.deepEqual(await fs.readFile(path.join(lifecycle.historyRoot, blob)), original);
  assert.equal((await lifecycle.read(file, versions[0].id)).content, doc.content);
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF# 二稿\r\n');
  await store.saveDocument(saved, { beforeReplace }); assert.equal(lifecycle.list(file).length, 1);
});

test('history failure and edits during history capture abort save without replacing disk contents', async t => {
  const { store, doc, file, lifecycle } = await fixture(t);
  const original = await fs.readFile(file);
  await assert.rejects(store.saveDocument({ ...doc, content: 'overwrite' }, { beforeReplace: () => { throw Error('history volume full'); } }), /history volume full/);
  assert.deepEqual(await fs.readFile(file), original);
  await assert.rejects(store.saveDocument({ ...doc, content: 'overwrite' }, { beforeReplace: async (file, bytes) => { await lifecycle.record(file, bytes); await fs.writeFile(file, 'new external edit'); } }), RevisionConflictError);
  assert.equal(await fs.readFile(file, 'utf8'), 'new external edit');
});

test('bounded history prunes count, per-document bytes, document count and total bytes, including orphan cleanup', async t => {
  const { lifecycle, file, root, store } = await fixture(t, { count: 3, documentBytes: 12, bytes: 18, documents: 2 });
  for (let n = 0; n < 6; n++) await lifecycle.record(file, Buffer.from(`ver${n}`));
  assert.equal(lifecycle.list(file).length, 3);
  assert.equal((await lifecycle.read(file, lifecycle.list(file)[0].id)).content, 'ver5');
  for (let n = 0; n < 4; n++) await lifecycle.record(path.join(root, `other-${n}.md`), Buffer.from('12345678'));
  assert.ok(lifecycle.history.length <= 2); assert.ok(lifecycle.history.reduce((sum, record) => sum + record.versions.reduce((sum, v) => sum + v.size, 0), 0) <= 18);
  const blob = `${'a'.repeat(64)}/${crypto.randomUUID()}.bin`; await fs.mkdir(path.dirname(path.join(lifecycle.historyRoot, blob))); await fs.writeFile(path.join(lifecycle.historyRoot, blob), 'orphan');
  const fresh = new LifecycleStore(store); await fresh.init(); assert.equal(await fs.stat(path.join(lifecycle.historyRoot, blob)).catch(() => null), null);
  const files = await fs.readdir(lifecycle.historyRoot, { recursive: true }); assert.equal(files.filter(file => file.endsWith('.bin')).length, fresh.history.flatMap(record => record.versions).length);
});

test('version IDs are scoped to document paths; renamed history follows the file and trash does not erase history', async t => {
  const { lifecycle, file, root } = await fixture(t);
  await lifecycle.record(file, Buffer.from('history')); const id = lifecycle.list(file)[0].id;
  await assert.rejects(lifecycle.read(path.join(root, 'other.md'), id), /不可用/);
  await assert.rejects(lifecycle.read(file, '../secret'), /Invalid version/);
  const moved = path.join(root, 'new.md'); await lifecycle.remap(file, moved);
  assert.equal(lifecycle.list(file).length, 0); assert.equal((await lifecycle.read(moved, id)).content, 'history');
  await lifecycle.remap(moved, null); assert.equal(lifecycle.list(moved).length, 1);
  await lifecycle.clear(moved); assert.equal(lifecycle.list(moved).length, 0);
});

test('history detects tampered data and preserves malformed indexes', async t => {
  const { lifecycle, file, store } = await fixture(t);
  await lifecycle.record(file, Buffer.from('trusted'));
  const version = lifecycle.history[0].versions[0]; await fs.writeFile(path.join(lifecycle.historyRoot, version.blob), 'tampered');
  await assert.rejects(lifecycle.read(file, version.id), /校验失败/);
  await fs.writeFile(lifecycle.indexPath, '{bad json'); const reloaded = new LifecycleStore(store); await reloaded.init();
  await assert.rejects(reloaded.record(file, Buffer.from('new')), /索引损坏/); assert.equal(await fs.readFile(lifecycle.indexPath, 'utf8'), '{bad json');
});

test('history refuses symbolic links and junctions in storage paths', async t => {
  const { lifecycle, file, root } = await fixture(t);
  await lifecycle.record(file, Buffer.from('trusted'));
  const version = lifecycle.history[0].versions[0], bucket = path.dirname(path.join(lifecycle.historyRoot, version.blob));
  const moved = path.join(root, 'moved-history'); await fs.rename(bucket, moved);
  try { await fs.symlink(moved, bucket, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not allow links'); return; } throw error; }
  await assert.rejects(lifecycle.read(file, version.id), /目录已变化/);
  assert.equal(await fs.readFile(path.join(moved, path.basename(version.blob)), 'utf8'), 'trusted');
});

test('save target ownership rejects overwriting another open tab, while the same owner may save', async t => {
  const { lifecycle, entry } = await fixture(t);
  await lifecycle.saveSession({ documents: [entry], activeId: entry.id });
  lifecycle.assertSaveTarget(entry.path, entry.id);
  assert.throws(() => lifecycle.assertSaveTarget(entry.path, 'another'), /另一个标签/);
  assert.throws(() => lifecycle.assertSaveTarget(entry.path, '../invalid'), /Invalid document tab/);
});

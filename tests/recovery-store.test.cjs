'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gzipSync } = require('node:zlib');
const { FileStore, digest } = require('../electron/file-store.cjs');
const { LifecycleStore } = require('../electron/lifecycle-store.cjs');
const { WindowSessions } = require('../electron/window-sessions.cjs');
const { readWindows } = require('./recovery-fixture.cjs');

const entry = (id, content) => ({ id, name: `${id}.md`, path: null, content, revision: null, dirty: true, mode: 'source', paused: null });
const session = (...documents) => ({ documents, activeId: documents[0]?.id || null });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'meki-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileStore(path.join(root, 'profile')); await store.init();
  const history = new LifecycleStore(store); await history.init();
  const windows = new WindowSessions(store, history); await windows.init();
  return { root, store, history, windows };
}
async function catalog(windows) { return JSON.parse(await fs.readFile(windows.filename, 'utf8')); }
async function bodies(windows) { return (await fs.readdir(windows.recovery.root)).filter(name => name.endsWith('.gz')).sort(); }

test('unchanged sessions write nothing; changed and metadata-only saves reuse every unchanged body', async t => {
  const { windows } = await fixture(t);
  const first = entry('a', '# A\n'.repeat(20000)), second = entry('b', '# B\n'.repeat(20000));
  await windows.save('main', session(first, second));
  const initial = await catalog(windows), renamed = [], rename = fs.rename;
  fs.rename = async (from, to) => { renamed.push(to); return rename(from, to); };
  t.after(() => { fs.rename = rename; });
  await windows.save('main', session(first, second)); assert.deepEqual(renamed, []);
  await windows.save('main', session({ ...first, content: first.content + 'edit' }, second));
  assert.equal(renamed.filter(name => name.endsWith('.gz')).length, 1);
  assert.equal(renamed.filter(name => name === windows.filename).length, 1);
  assert.equal((await catalog(windows)).windows[0].session.documents[1].contentRef.hash, initial.windows[0].session.documents[1].contentRef.hash);
  renamed.length = 0;
  await windows.update('main', { bounds: { x: 20, y: 30, width: 800, height: 600, maximized: false } });
  assert.deepEqual(renamed, [windows.filename]);
  assert.equal(await fs.stat(windows.legacyFilename).catch(() => null), null);
  assert.equal(await fs.stat(windows.history.sessionPath).catch(() => null), null);
  assert.equal((await bodies(windows)).length, 2);
});

test('compressed bodies preserve exact text, including BOM, CRLF, Unicode and partial surrogate pairs', async t => {
  const { windows, store } = await fixture(t);
  const content = '\uFEFF---\r\ntitle: 测试\r\n---\r\n"\\\t😀\uD800\r\n';
  await windows.save('main', session(entry('a', content)));
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, content);
  const repeated = '# Markdown 正文\n'.repeat(50000);
  await windows.save('main', session(entry('a', repeated)));
  const ref = (await catalog(windows)).windows[0].session.documents[0].contentRef;
  assert.ok((await fs.stat(windows.recovery.blob(ref))).size < Buffer.byteLength(repeated) / 10);
});

test('identical documents share one immutable body and closing a tab removes only unreferenced bodies', async t => {
  const { windows, store } = await fixture(t);
  await windows.save('main', session(entry('a', 'shared'), entry('b', 'shared')));
  assert.equal((await bodies(windows)).length, 1);
  await windows.save('main', session(entry('a', 'changed'), entry('b', 'shared')));
  assert.equal((await bodies(windows)).length, 2);
  assert.equal((await readWindows(store.userData))[0].session.documents[1].content, 'shared');
  await fs.writeFile(path.join(windows.recovery.root, 'unrelated.txt'), 'leave me');
  await windows.save('main', session(entry('a', 'changed')));
  assert.equal((await bodies(windows)).length, 1);
  assert.equal(await fs.readFile(path.join(windows.recovery.root, 'unrelated.txt'), 'utf8'), 'leave me');
});

test('an interrupted catalog commit retains the previous complete state and removes staged bodies', async t => {
  const { windows, store } = await fixture(t);
  await windows.save('main', session(entry('a', 'before')));
  const before = await fs.readFile(windows.filename), blobs = await bodies(windows), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === windows.filename) throw Error('simulated catalog failure'); return rename(from, to); };
  try { await assert.rejects(windows.save('main', session(entry('a', 'after'), entry('b', 'other'))), /catalog failure/); }
  finally { fs.rename = rename; }
  assert.deepEqual(await fs.readFile(windows.filename), before); assert.deepEqual(await bodies(windows), blobs);
  assert.equal(windows.get('main').session.documents[0].content, 'before');
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, 'before');
});

test('a body write failure never advances the catalog; cleanup failure never reverses a committed edit', async t => {
  const { windows, store } = await fixture(t);
  await windows.save('main', session(entry('a', 'before')));
  const rename = fs.rename, unlink = fs.unlink;
  fs.rename = async (from, to) => { if (to.endsWith('.gz')) throw Error('body disk full'); return rename(from, to); };
  try { await assert.rejects(windows.save('main', session(entry('a', 'failed'))), /disk full/); }
  finally { fs.rename = rename; }
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, 'before');
  fs.unlink = async filename => { if (filename.endsWith('.gz')) throw Error('cleanup unavailable'); return unlink(filename); };
  try { await windows.save('main', session(entry('a', 'committed'))); }
  finally { fs.unlink = unlink; }
  assert.equal(windows.get('main').session.documents[0].content, 'committed');
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, 'committed');
  assert.equal((await bodies(windows)).length, 2);
  await windows.save('main', session(entry('a', 'committed'))); assert.equal((await bodies(windows)).length, 1);
});

test('legacy windows migrate once, normal close exports them, and later edits in older code import once even with stale timestamps', async t => {
  const { windows, store, history } = await fixture(t);
  const old = JSON.stringify({ version: 1, windows: [{ id: 'main', session: session(entry('a', 'legacy')) }] });
  await fs.writeFile(windows.legacyFilename, old);
  const migrated = new WindowSessions(store, history); await migrated.init(); await migrated.startup(false);
  assert.equal(migrated.get('main').session.documents[0].content, 'legacy');
  assert.equal(await fs.readFile(windows.legacyFilename, 'utf8'), old);
  await migrated.save('main', session(entry('a', 'new format')));
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, 'new format');
  await migrated.clean(['main']);
  const exported = JSON.parse(await fs.readFile(windows.legacyFilename, 'utf8'));
  assert.equal(exported.windows[0].session.documents[0].content, 'new format');
  assert.equal(exported.recoveryRevision, migrated.recovery.revision);
  await migrated.save('main', session(entry('a', 'later new edit')));
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, 'later new edit');
  await fs.writeFile(windows.legacyFilename, JSON.stringify({ version: 1, windows: [{ id: 'main', session: session(entry('a', 'older app edit')) }] }));
  await fs.utimes(windows.legacyFilename, new Date(0), new Date(0));
  const rolledBack = new WindowSessions(store, history); await rolledBack.init(); await rolledBack.startup(false);
  assert.equal(rolledBack.get('main').session.documents[0].content, 'older app edit');
  await rolledBack.save('main', session(entry('a', 'latest new edit')));
  assert.equal((await readWindows(store.userData))[0].session.documents[0].content, 'latest new edit');
});

test('corrupt bodies are preserved together with their catalog before falling back to the legacy checkpoint', async t => {
  const { windows, store, history } = await fixture(t);
  await windows.save('main', session(entry('a', 'checkpoint'))); await windows.clean(['main']);
  await windows.save('main', session(entry('a', 'latest'), entry('b', 'other body')));
  const before = await fs.readFile(windows.filename), refs = (await catalog(windows)).windows[0].session.documents.map(doc => doc.contentRef);
  const broken = windows.recovery.blob(refs[0]); await fs.writeFile(broken, 'invalid compressed contents');
  const repaired = new WindowSessions(store, history); await repaired.init();
  assert.equal(repaired.corrupt, true); assert.equal(repaired.get('main').session.documents[0].content, 'checkpoint');
  await repaired.save('main', session(entry('a', 'replacement')));
  const backup = (await fs.readdir(store.userData)).find(name => name.startsWith('recovery-corrupt-'));
  assert.deepEqual(await fs.readFile(path.join(store.userData, backup, 'windows.json')), before);
  assert.equal(await fs.readFile(path.join(store.userData, backup, path.basename(broken)), 'utf8'), 'invalid compressed contents');
  assert.ok(await fs.stat(path.join(store.userData, backup, `${refs[1].hash}.gz`)));
});

test('recovery paths reject links and traversal, and decompression is bounded by declared document size', async t => {
  const { windows, root } = await fixture(t);
  await windows.save('main', session(entry('a', 'keep')));
  const ref = (await catalog(windows)).windows[0].session.documents[0].contentRef;
  assert.throws(() => windows.recovery.blob({ hash: '../outside', bytes: 1 }), /引用无效/);
  const external = path.join(root, 'external'), filename = windows.recovery.blob(ref);
  await fs.writeFile(external, await fs.readFile(filename)); await fs.unlink(filename); await fs.link(external, filename);
  await assert.rejects(windows.recovery.readContent(ref), /普通文件/);
  await assert.rejects(windows.save('main', session(entry('a', 'keep'))), /普通文件/);
  assert.ok(await fs.readFile(external));
  const encoded = Buffer.from(JSON.stringify('x'.repeat(10000))), bad = { hash: digest(encoded), bytes: 1 };
  await fs.writeFile(windows.recovery.blob(bad), gzipSync(encoded));
  await assert.rejects(windows.recovery.readContent(bad), /larger than|too large|buffer/i);
});

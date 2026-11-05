'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileStore, pathKey, validateSettings, DEFAULT_SETTINGS } = require('../electron/file-store.cjs');
const { SnapshotStore } = require('../electron/snapshot-store.cjs');
const { randomUUID } = require('node:crypto');

async function fixture(t, limits) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'meki-snapshots-')));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(pathKey(path.dirname(resolved)), pathKey(parent));
    assert.ok(path.basename(resolved).startsWith('meki-snapshots-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const store = new FileStore(path.join(root, 'profile')); await store.init();
  const snapshots = new SnapshotStore(store, limits); await snapshots.init();
  const input = { path: null, name: '未命名.md', revision: null, content: '# 草稿\n', tabId: 'draft-one', kind: 'manual' };
  return { root, store, snapshots, input };
}

test('snapshot settings migrate independently and validate short idle saves and snapshot intervals', async t => {
  const { root } = await fixture(t);
  const profile = path.join(root, 'old-profile'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { autoSave: true, autoSaveInterval: 120, autoSnapshot: 'bad' } }));
  const restored = new FileStore(profile); await restored.init();
  assert.equal(restored.metadata.settings.autoSaveInterval, 120);
  assert.equal(restored.metadata.settings.autoSave, true);
  assert.equal(restored.metadata.settings.autoSnapshot, true);
  assert.equal(DEFAULT_SETTINGS.autoSaveOnBlur, true); assert.equal(DEFAULT_SETTINGS.snapshotInterval, 60);
  assert.equal(validateSettings({ autoSaveInterval: 2, snapshotInterval: 10 }).autoSaveInterval, 2);
  for (const patch of [{ autoSaveInterval: 1 }, { autoSaveOnBlur: 1 }, { autoSnapshot: 1 }, { snapshotInterval: 9 }, { snapshotInterval: 601 }]) assert.throws(() => validateSettings(patch));
});

test('manual snapshots retain exact buffer text across restart without touching Markdown or file history', async t => {
  const { snapshots, store, root, input } = await fixture(t);
  const file = path.join(root, 'original.md'); await fs.writeFile(file, 'disk bytes');
  const content = '\uFEFF---\r\ntitle: 快照\r\n---\r\n# α\r\n';
  const entry = await snapshots.create({ ...input, path: file, content, label: '改写前 <tag>' });
  assert.equal(await fs.readFile(file, 'utf8'), 'disk bytes');
  assert.equal(await fs.stat(path.join(store.userData, 'versions')).catch(() => null), null);
  const reopened = new SnapshotStore(store); await reopened.init();
  assert.equal((await reopened.read(entry.id)).content, content);
  assert.equal(reopened.list({ path: file, tabId: 'new-tab' })[0].label, '改写前 <tag>');
  assert.equal(reopened.list({ path: null, tabId: input.tabId }).length, 0);
});

test('untitled snapshots are isolated by stable tab identity and automatic identical content is deduplicated', async t => {
  const { snapshots, input } = await fixture(t);
  const first = await snapshots.create({ ...input, kind: 'auto' });
  const again = await snapshots.create({ ...input, kind: 'auto' }); assert.equal(again.id, first.id);
  await snapshots.create({ ...input, label: 'Checkpoint' });
  await snapshots.create({ ...input, tabId: 'draft-two', content: 'other' });
  assert.equal(snapshots.list().length, 3);
  assert.equal(snapshots.list(input).length, 2);
  const latest = await snapshots.create({ ...input, kind: 'auto' }); assert.equal(latest.kind, 'manual');
});

test('retention prunes automatic snapshots and protects named manual snapshots', async t => {
  const { snapshots, input } = await fixture(t, { count: 3 });
  const manual = await snapshots.create({ ...input, label: 'Keep me' });
  const oldest = await snapshots.create({ ...input, content: 'old auto', kind: 'auto' });
  await snapshots.create({ ...input, content: 'backup', kind: 'restore' });
  const latest = await snapshots.create({ ...input, content: 'new auto', kind: 'auto' });
  assert.equal(snapshots.list().length, 3);
  assert.equal((await snapshots.read(manual.id)).content, input.content);
  assert.equal((await snapshots.read(latest.id)).content, 'new auto');
  await assert.rejects(snapshots.read(oldest.id), /不可用/);
  assert.equal(await fs.stat(path.join(snapshots.root, `${oldest.id}.bin`)).catch(() => null), null);
});

test('automatic history keeps dense recent edits and the newest minute, hour and day versions per document', async t => {
  const { snapshots, input } = await fixture(t);
  const minute = 60000, hour = 60 * minute, day = 24 * hour;
  const now = Date.UTC(2030, 5, 15, 12);
  const entry = (age, patch = {}) => ({ ...input, id: randomUUID(), size: 1, kind: 'auto', createdAt: now - age, ...patch });
  const recent = [entry(1000), entry(2000)];
  const minutes = [entry(20 * minute + 1000), entry(20 * minute + 2000), entry(21 * minute + 1000)];
  const hours = [entry(2 * hour + 10 * minute), entry(2 * hour + 20 * minute), entry(3 * hour + 10 * minute)];
  const days = [entry(2 * day + 2 * hour), entry(2 * day + 3 * hour), entry(3 * day)];
  const named = entry(2 * day + 4 * hour, { kind: 'manual' });
  const other = entry(2 * day + 5 * hour, { tabId: 'another-draft' });
  const kept = snapshots.prune([...recent, ...minutes, ...hours, ...days, named, other]);
  assert.deepEqual(new Set(kept.map(item => item.id)), new Set([
    ...recent, minutes[0], minutes[2], hours[0], hours[2], days[0], days[2], named, other,
  ].map(item => item.id)));
});

test('aged legacy indexes stay readable on restart; compaction commits only with the next version', async t => {
  const { snapshots, store, input } = await fixture(t);
  const created = [];
  for (let i = 0; i < 24; i++) created.push(await snapshots.create({ ...input, content: `edit ${i}`, kind: 'auto' }));
  assert.equal(snapshots.list().length, 24, 'history extends beyond the old 20-version limit');
  const aged = snapshots.list().map((entry, i) => ({ ...entry, createdAt: Date.UTC(2020, 0, 1, 12) - i * 60000 }));
  await snapshots.writeIndex(aged);
  const reopened = new SnapshotStore(store); await reopened.init();
  assert.equal(reopened.list().length, 24);
  assert.equal((await reopened.read(created[0].id)).content, 'edit 0');
  const writeIndex = reopened.writeIndex.bind(reopened);
  reopened.writeIndex = async () => { throw new Error('compaction disk full'); };
  await assert.rejects(reopened.create({ ...input, content: 'today', kind: 'auto' }), /disk full/);
  assert.equal(reopened.list().length, 24);
  assert.equal((await reopened.read(created[0].id)).content, 'edit 0');
  reopened.writeIndex = writeIndex;
  await reopened.create({ ...input, content: 'today', kind: 'auto' });
  assert.equal(reopened.list().length, 2);
  assert.equal((await reopened.read(aged[0].id)).content, 'edit 23');
  assert.equal(await fs.stat(path.join(snapshots.root, `${aged[1].id}.bin`)).catch(() => null), null);
  const restarted = new SnapshotStore(store); await restarted.init();
  assert.equal(restarted.list().length, 2);
});

test('full manual quota refuses new automatic and manual snapshots without deleting existing content', async t => {
  const { snapshots, input } = await fixture(t, { count: 1 });
  const original = await snapshots.create(input);
  for (const kind of ['auto', 'manual', 'restore']) await assert.rejects(snapshots.create({ ...input, content: 'new', kind }), /空间已满/);
  assert.deepEqual(snapshots.list().map(item => item.id), [original.id]);
  assert.equal((await fs.readdir(snapshots.root)).length, 2);
});

test('global byte and document limits evict only eligible snapshots and bound each document', async t => {
  const { snapshots, input } = await fixture(t, { documentBytes: 8, totalBytes: 10, documents: 2 });
  const manual = await snapshots.create({ ...input, content: '1234' });
  const old = await snapshots.create({ ...input, tabId: 'two', kind: 'auto', content: '1234' });
  await snapshots.create({ ...input, tabId: 'three', kind: 'auto', content: '1234' });
  assert.equal(snapshots.list().length, 2);
  assert.ok(snapshots.list().some(item => item.id === manual.id));
  assert.ok(!snapshots.list().some(item => item.id === old.id));
  await assert.rejects(snapshots.create({ ...input, kind: 'auto', content: '123456789' }), /空间已满/);
});

test('failed index writes leave the previous index and snapshots readable without orphaning the new blob', async t => {
  const { snapshots, input } = await fixture(t, { count: 1 });
  const first = await snapshots.create({ ...input, kind: 'auto' });
  const original = await fs.readFile(snapshots.indexPath);
  snapshots.writeIndex = async () => { throw new Error('simulated disk full'); };
  await assert.rejects(snapshots.create({ ...input, kind: 'auto', content: 'later' }), /disk full/);
  assert.deepEqual(await fs.readFile(snapshots.indexPath), original);
  assert.equal((await snapshots.read(first.id)).content, input.content);
  assert.deepEqual((await fs.readdir(snapshots.root)).sort(), [`${first.id}.bin`, 'index.json'].sort());
});

test('corrupt indexes fail closed and preserve every existing byte', async t => {
  const { snapshots, store, input } = await fixture(t);
  const entry = await snapshots.create(input);
  await fs.writeFile(snapshots.indexPath, '{invalid');
  const reopened = new SnapshotStore(store); await reopened.init();
  assert.throws(() => reopened.list(), /保留原数据/);
  await assert.rejects(reopened.create(input), /保留原数据/);
  assert.equal(await fs.readFile(snapshots.indexPath, 'utf8'), '{invalid');
  assert.equal(await fs.readFile(path.join(snapshots.root, `${entry.id}.bin`), 'utf8'), input.content);
});

test('snapshot reads detect tampering and reject traversal, malformed targets and labels', async t => {
  const { snapshots, input } = await fixture(t);
  const entry = await snapshots.create(input);
  await fs.writeFile(path.join(snapshots.root, `${entry.id}.bin`), 'tampered');
  await assert.rejects(snapshots.read(entry.id), /校验失败/);
  await assert.rejects(snapshots.read('../index.json'), /ID/);
  for (const patch of [{ path: '../outside.md' }, { tabId: '../escape' }, { kind: 'other' }, { content: 'bad\0' }, { label: 'x'.repeat(81) }, { label: 'a\nb' }]) await assert.rejects(snapshots.create({ ...input, ...patch }));
});

test('snapshot blobs and storage roots reject filesystem links', async t => {
  const { snapshots, root, store, input } = await fixture(t);
  const entry = await snapshots.create(input), blob = path.join(snapshots.root, `${entry.id}.bin`);
  const external = path.join(root, 'external.txt'); await fs.writeFile(external, input.content);
  await fs.unlink(blob); await fs.link(external, blob);
  await assert.rejects(snapshots.read(entry.id), /链接/);
  assert.equal(await fs.readFile(external, 'utf8'), input.content);
  const other = new FileStore(path.join(root, 'other-profile')); await other.init();
  await fs.symlink(snapshots.root, path.join(other.userData, 'snapshots-v1'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = new SnapshotStore(other); await linked.init();
  await assert.rejects(linked.create(input), /链接/);
  assert.equal(store.userData, path.join(root, 'profile'));
});

test('first save adopts untitled snapshots, workspace renames migrate them and trash retains them', async t => {
  const { snapshots, input, root } = await fixture(t);
  const entry = await snapshots.create(input);
  const old = path.join(root, 'notes', 'a.md'), next = path.join(root, 'renamed', 'a.md');
  await snapshots.adopt(input.tabId, old);
  assert.equal(snapshots.list(input).length, 0);
  assert.equal(snapshots.list({ path: old, tabId: 'reopened' })[0].id, entry.id);
  await snapshots.remap(path.dirname(old), path.dirname(next));
  assert.equal(snapshots.list()[0].path, next);
  await snapshots.remap(next, null); assert.equal(snapshots.list()[0].path, next);
  await snapshots.delete(entry.id);
  assert.equal(snapshots.list().length, 0);
  assert.equal(await fs.stat(path.join(snapshots.root, `${entry.id}.bin`)).catch(() => null), null);
});

test('concurrent snapshot requests serialize without lost index entries and cleanup is scoped to UUID blobs', async t => {
  const { snapshots, input, store } = await fixture(t);
  const entries = await Promise.all(Array.from({ length: 8 }, (_, i) => snapshots.create({ ...input, content: `content ${i}` })));
  assert.equal(new Set(entries.map(item => item.id)).size, 8);
  assert.equal(snapshots.list().length, 8);
  const orphan = '11111111-2222-3333-4444-555555555555.bin';
  await fs.writeFile(path.join(snapshots.root, orphan), 'orphan');
  await fs.writeFile(path.join(snapshots.root, 'unrelated.txt'), 'keep');
  const reopened = new SnapshotStore(store); await reopened.init();
  assert.equal(reopened.list().length, 8);
  assert.equal(await fs.stat(path.join(snapshots.root, orphan)).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(snapshots.root, 'unrelated.txt'), 'utf8'), 'keep');
});

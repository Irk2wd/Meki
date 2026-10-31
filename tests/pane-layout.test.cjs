'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { groups, dockTab, mergeGroup, reconcileLayout, validateLayout } = require('../electron/pane-layout.mjs');
const { FileStore } = require('../electron/file-store.cjs');
const { LifecycleStore, validateSession } = require('../electron/lifecycle-store.cjs');
const { WindowSessions } = require('../electron/window-sessions.cjs');
const single = (...tabs) => ({ type: 'group', id: 'initial', tabs, activeId: tabs[0] });
const doc = id => ({ id, path: null, name: id + '.md', content: '\uFEFF# ' + id + '\r\n\r\nunsaved\r\n', revision: null, dirty: true, mode: 'source', paused: null });

test('four edge drops preserve document identities and leave the input layout untouched', () => {
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const before = single('a', 'b'), next = dockTab(before, 'b', 'initial', edge, null, 'second');
    assert.deepEqual(before, single('a', 'b'));
    assert.equal(next.axis, ['left', 'right'].includes(edge) ? 'row' : 'column');
    assert.deepEqual(groups(next).map(group => group.tabs[0]), ['left', 'top'].includes(edge) ? ['b', 'a'] : ['a', 'b']);
    assert.deepEqual(validateLayout(next, ['a', 'b']), next);
  }
});
test('moving the last tab collapses its old group and merging retains every tab', () => {
  const split = dockTab(single('a', 'b', 'c'), 'b', 'initial', 'right', null, 'second');
  const merged = dockTab(split, 'b', 'initial', null, 'c', 'unused');
  assert.deepEqual(merged.tabs, ['a', 'b', 'c']);
  assert.equal(merged.activeId, 'b');
  assert.deepEqual(groups(mergeGroup(split, 'second')).flatMap(group => group.tabs).sort(), ['a', 'b', 'c']);
  assert.deepEqual(dockTab(single('a'), 'a', 'initial', 'top', null, 'empty'), single('a'));
});
test('nested splits enforce four panes while allowing a singleton to move to another edge', () => {
  let layout = single('a', 'b', 'c', 'd', 'e');
  for (const [id, edge] of [['b', 'right'], ['c', 'bottom'], ['d', 'left']]) layout = dockTab(layout, id, 'initial', edge, null, id);
  assert.equal(groups(layout).length, 4);
  assert.throws(() => dockTab(layout, 'e', 'initial', 'top', null, 'e'), /4/);
  const moved = dockTab(layout, 'b', 'initial', 'top', null, 'new-b');
  assert.equal(groups(moved).length, 4); assert.deepEqual(groups(moved).flatMap(group => group.tabs).sort(), ['a', 'b', 'c', 'd', 'e']);
});
test('untrusted layout data rejects duplicate tabs, missing tabs, ratios, IDs and excessive depth', () => {
  const layout = dockTab(single('a', 'b'), 'b', 'initial', 'right', null, 'second');
  for (const invalid of [null, { ...layout, ratio: NaN }, { ...layout, ratio: 0 }, { ...layout, axis: 'grid' }, { ...layout, second: { ...layout.second, tabs: ['a'], activeId: 'a' } }, { ...layout, second: { ...layout.second, id: 'initial' } }, single('a'), { ...single('a', 'b'), activeId: 'missing' }]) assert.throws(() => validateLayout(invalid, ['a', 'b']));
  assert.throws(() => validateSession({ documents: [doc('a'), doc('b')], activeId: 'a', layout: single('a') }));
});
test('closing or failing to restore a document prunes only its pane and keeps surviving proportions', () => {
  let layout = dockTab(single('a', 'b', 'c'), 'b', 'initial', 'right', null, 'second'); layout.ratio = .64;
  const retained = reconcileLayout(layout, ['a', 'b'], 'a');
  assert.equal(retained.ratio, .64); assert.deepEqual(groups(retained).flatMap(group => group.tabs), ['a', 'b']);
  assert.deepEqual(reconcileLayout(layout, ['b'], 'b'), { type: 'group', id: 'second', tabs: ['b'], activeId: 'b' });
  assert.equal(reconcileLayout(layout, [], null), undefined);
});
test('window recovery persists split layout, dirty exact bytes and mode; old sessions stay compatible', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'moye-pane-session-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); await fs.rm(root, { recursive: true, force: true }); });
  const store = new FileStore(root); await store.init(); const history = new LifecycleStore(store); await history.init();
  const windows = new WindowSessions(store, history); await windows.init();
  const documents = [doc('a'), doc('b')], layout = dockTab(single('a', 'b'), 'b', 'initial', 'bottom', null, 'second'); layout.ratio = .62;
  await windows.save('main', { documents, activeId: 'b', layout });
  const restored = new WindowSessions(store, history); await restored.init(); const records = await restored.startup(false);
  assert.deepEqual(records[0].session.layout, layout);
  assert.equal(records[0].session.documents[0].content, documents[0].content);
  assert.equal(records[0].session.documents[1].mode, 'source');
  const legacy = { documents, activeId: 'a' }; assert.deepEqual(validateSession(legacy), legacy);
  const beforeTransfer = structuredClone(restored.get('main').session.documents);
  const second = await restored.add(); await restored.transfer('main', second, 'b');
  assert.deepEqual(restored.get('main').session.layout, single('a'));
  assert.equal(restored.get(second).session.documents[0].content, documents[1].content);
  await restored.rollbackTransfer('main', second, layout);
  assert.deepEqual(restored.get('main').session.layout, layout);
  assert.deepEqual(restored.get('main').session.documents, beforeTransfer);
});

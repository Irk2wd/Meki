'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ResearchStore } = require('../electron/research-store.cjs');
const { exampleProject, exampleRecords } = require('../electron/research-example.cjs');
const { formatMarkdown } = require('../electron/research-model.cjs');
const { WorkspaceStore } = require('../electron/workspace-store.cjs');

async function projectFolder(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mekir-layout-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return path.join(temporary, 'project');
}

test('a legacy project keeps its records and sibling Markdown links', async t => {
  const root = await projectFolder(t);
  await fs.mkdir(path.join(root, 'records'), { recursive: true });
  await fs.writeFile(path.join(root, 'meki-project.json'), JSON.stringify(exampleProject));
  const { body, ...record } = exampleRecords[0];
  await fs.writeFile(path.join(root, 'records', 'r-baseline-city.md'), formatMarkdown({
    ...record, fields: { ...record.fields, gpu: 'RTX 4080', resolution: '2560×1440' },
  }, body));

  const store = await ResearchStore.open(root);
  assert.equal(store.manifestFile, 'meki-project.json');
  assert.equal((await store.snapshot()).documents[0].id, 'baseline-city');
  const { records } = await store.writeBatch({ records: [{
    id: 'review', type: 'stage-summary', title: 'Legacy review', date: '2026-11-06',
    coverage: { start: '2026-11-04', end: '2026-11-05' }, sources: ['baseline-city'],
  }] });
  assert.equal(records[0].relativePath, 'records/r-review.md');
  assert.match((await store.read('review')).body, /\]\(r-baseline-city\.md\)/);
  await assert.rejects(fs.access(path.join(root, '.mekir')), { code: 'ENOENT' });
});

test('the index reserves IDs and resolves only documents inside the project', async t => {
  const root = await projectFolder(t);
  const store = await ResearchStore.initialize(root, exampleProject, exampleRecords);
  const outside = path.join(path.dirname(root), 'outside.md');
  const note = path.join(root, 'note.md');
  await fs.writeFile(outside, 'Outside');
  await fs.writeFile(note, '# Original note');
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(root, 'alias.md'));
    await assert.rejects(store.indexDocument('alias', 'alias.md'));
  }
  await assert.rejects(store.indexDocument('outside', '../outside.md'), /project-relative/);
  await assert.rejects(store.indexDocument('baseline-city', 'note.md'), /already uses/);
  await assert.rejects(store.indexDocument('inside', '.mekir/summaries/r-exploration-review.md'), /project-relative/);
  await store.indexDocument('reference', 'note.md');
  const workspace = await WorkspaceStore.open(root);
  await assert.rejects(workspace.operate({
    action: 'rename', path: path.join(root, '.mekir'), name: 'metadata',
  }), /受保护/);
  const { records } = await store.writeBatch({ records: [{
    id: 'review', type: 'stage-summary', title: 'Indexed review', date: '2026-11-06',
    coverage: { start: '2026-11-04', end: '2026-11-05' }, sources: ['reference'],
  }] });
  assert.equal(records[0].relativePath, '.mekir/summaries/r-review.md');
  const moved = path.join(root, 'new-note.md');
  await fs.rename(note, moved);
  const missing = await store.snapshot();
  assert.match(missing.records.find(({ record }) => record.id === 'review').issues[0], /Missing source document: reference/);
  await assert.rejects(store.writeBatch({ records: [{ id: 'reference' }] }), /index already uses ID/);
  await store.indexDocument('reference', 'new-note.md');
  assert.equal((await store.resolveDocument('reference')).relativePath, 'new-note.md');
  assert.deepEqual((await store.snapshot()).records.find(({ record }) => record.id === 'review').issues, []);
  assert.equal((await store.read('review')).revision, records[0].revision);
});

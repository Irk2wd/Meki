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
const { previewEvidence } = require('../electron/research-evidence.cjs');

async function projectFolder(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mekir-layout-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return path.join(temporary, 'project');
}

async function archiveProject(t) {
  const root = await projectFolder(t);
  const directory = path.dirname(root);
  const previous = process.env.MEKIR_LOCAL_STATE;
  process.env.MEKIR_LOCAL_STATE = path.join(directory, 'local-state');
  t.after(() => {
    if (previous === undefined) delete process.env.MEKIR_LOCAL_STATE;
    else process.env.MEKIR_LOCAL_STATE = previous;
  });
  return { store: await ResearchStore.initialize(root, exampleProject, exampleRecords), directory };
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

test('indexed evidence stays read-only and resolves after rebinding the source ID', async t => {
  const { store, directory } = await archiveProject(t);
  const paper = path.join(directory, 'paper');
  await fs.mkdir(paper);
  await fs.writeFile(path.join(paper, 'final.tex'), '\\section{Experimental results}\n');
  await store.bindEvidenceSource('paper', paper, '论文仓库');
  await store.indexEvidence('paper-v3', { sourceId: 'paper', relativePath: 'final.tex', title: '论文 v3' });
  assert.deepEqual((await store.manifest()).project.evidenceSources, [{ id: 'paper', label: '论文仓库' }]);
  await assert.rejects(store.indexEvidence('escape', { sourceId: 'paper', relativePath: '../outside.txt', title: 'Outside' }), /source-relative/);
  if (process.platform !== 'win32') {
    const outside = path.join(directory, 'outside.md');
    await fs.writeFile(outside, '# Unrelated');
    await fs.symlink(outside, path.join(paper, 'alias.md'));
    await assert.rejects(store.indexEvidence('escape', { sourceId: 'paper', relativePath: 'alias.md', title: 'Outside' }), /outside its source/);
  }
  const mounted = path.join(directory, 'new-drive');
  await fs.rename(paper, mounted);
  await assert.rejects(store.evidenceFile('paper-v3'), /unavailable/);
  const revision = (await store.manifest()).revision;
  await store.bindEvidenceSource('paper', mounted);
  assert.equal((await store.manifest()).revision, revision);
  const { file, reference, source } = await store.evidenceFile('paper-v3');
  assert.equal(file.path, path.join(mounted, 'final.tex'));
  assert.equal((await previewEvidence(file, reference, source)).content, '\\section{Experimental results}\n');
  assert.equal((await store.resolveDocument('paper-v3')).relativePath, 'final.tex');
});

test('archive import previews changes and incomplete reports, and retrying updates the same run', async t => {
  const { store, directory } = await archiveProject(t);
  const archive = path.join(directory, 'archive');
  const performance = path.join(archive, 'performance');
  const chosen = path.join(performance, '20261117_final30000');
  await fs.mkdir(path.join(chosen, 'figures'), { recursive: true });
  const report = '# 森林四视角报告\n\n- Run ID: final30000\n\n## 研究问题\n树冠遮挡如何影响帧时间\n\n## 证据\n[树冠原图](figures/canopy.png)\n';
  await fs.writeFile(path.join(chosen, 'RUN.md'), report);
  await fs.writeFile(path.join(chosen, 'figures', 'canopy.png'), 'image fixture');
  await fs.writeFile(path.join(chosen, 'metrics.csv'), 'round,ms\n1,10.9\n');
  const manifest = { run_id: 'final30000', date: '2026-11-17', camera: '固定四视角', models: ['Electric Dreams'],
    evaluation_protocol: '同模型同相机，统计逐轮 GPU 帧时间', outputs: ['F:\\UniLOD_Data\\03_experiment_results\\performance\\20261117_final30000\\metrics.csv', 'missing.json'] };
  const manifestFile = path.join(chosen, 'run_manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const pendingNames = Array.from({ length: 64 }, (_, i) => `20261112_pending_${i}`);
  await Promise.all(pendingNames.map(name => fs.mkdir(path.join(performance, name))));
  await store.bindEvidenceSource('archive', archive, 'F 盘归档');

  const preview = await store.importArchive('archive');
  assert.equal(preview.runs.filter(run => run.missing.includes('RUN.md')).length, 64);
  assert.equal(preview.runs.filter(run => run.change === 'new').length, 65);
  assert.deepEqual(preview.runs.find(run => run.runId === 'final30000').missing, ['missing.json']);
  assert.equal((await store.snapshot()).records.length, exampleRecords.length);
  manifest.status = 'promoted';
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(store.importArchive('archive', preview.token), /archive import plan changed/);
  const approved = await store.importArchive('archive');
  const applied = await store.importArchive('archive', approved.token);
  assert.equal(applied.records.length, 65);
  const repeated = await store.importArchive('archive');
  assert.ok(repeated.runs.every(run => run.change === 'unchanged'));
  assert.deepEqual((await store.importArchive('archive', approved.token)).records, []);
  assert.deepEqual((await store.importArchive('archive', repeated.token)).records, []);
  const snapshot = await store.snapshot();
  const chosenRecord = snapshot.records.find(({ record }) => record.run?.id === 'final30000');
  const original = await store.read(chosenRecord.record.id);
  assert.match(original.body, /\[树冠原图\]\(mekir:evidence-[a-f0-9]+\)/);
  assert.equal(original.record.run.context.question, '树冠遮挡如何影响帧时间');
  assert.equal(original.record.run.context.camera, '固定四视角');
  const csv = snapshot.documents.find(file => file.title === 'metrics.csv');
  assert.ok(original.record.run.evidence.includes(csv.id));
  assert.equal((await store.evidenceFile(csv.id)).file.path, path.join(chosen, 'metrics.csv'));

  const pending = snapshot.records.find(({ record }) => record.run?.id === pendingNames[0]);
  await store.writeBatch({ records: [{ id: pending.record.id, ifRevision: pending.revision, body: '# 回顾\n\n人工注释需保留。\n' }] });
  await fs.writeFile(path.join(performance, pendingNames[0], 'RUN.md'), '# 补录报告\n\n- Run ID: final3000\n');
  const reportUpdated = report + '\n## 补充记录\n加入逐轮帧时间明细。\n';
  await fs.writeFile(path.join(chosen, 'RUN.md'), reportUpdated);
  const patched = await store.importArchive('archive');
  assert.equal(patched.runs.find(run => run.runId === 'final3000').change, 'changed');
  const patchedIds = (await store.importArchive('archive', patched.token)).records.map(record => record.id);
  assert.deepEqual(new Set(patchedIds), new Set([pending.record.id, chosenRecord.record.id]));
  const updated = await store.read(pending.record.id);
  assert.equal(updated.record.run.id, 'final3000');
  assert.doesNotMatch(updated.record.run.missing.join(' '), /RUN.md/);
  assert.match(updated.body, /人工注释需保留/);
  const final = await store.read(chosenRecord.record.id);
  assert.match(final.body, /加入逐轮帧时间明细/);
  assert.equal(await fs.readFile(path.join(chosen, 'RUN.md'), 'utf8'), reportUpdated);

  const filter = { query: 'Electric Dreams ＋ 性能 ＋ 11 月', fields: [{ field: 'run.camera', value: '四视角' }] };
  assert.deepEqual((await store.snapshot(filter)).matchingIds, [chosenRecord.record.id]);
  const saved = await store.saveFilter('森林测量', filter);
  assert.equal((await store.manifest()).project.savedFilters[0].id, saved.id);
  assert.equal((await store.snapshot({ query: '待补报告' })).matchingIds.length, 63);
  assert.deepEqual((await store.snapshot({ query: '逐轮帧时间明细' })).matchingIds, [chosenRecord.record.id]);

  const relations = [{ kind: 'replaces', target: pending.record.id, note: '剔除规则补齐后采用四视角复测。' },
    { kind: 'paper-version', target: csv.id }];
  await store.writeBatch({ records: [{ id: chosenRecord.record.id, ifRevision: final.revision, relations, evidence: [csv.id] }] });
  assert.deepEqual((await store.read(chosenRecord.record.id)).record.relations, relations);
  assert.deepEqual((await store.snapshot({ query: '剔除规则补齐' })).matchingIds, [chosenRecord.record.id]);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ResearchStore } = require('../electron/research-store.cjs');
const { exampleProject, exampleRecords } = require('../electron/research-example.cjs');
const { formatMarkdown, validateProject } = require('../electron/research-model.cjs');
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

test('a research phase requires a start date and allows an unknown end date', () => {
  const phase = { id: 'continuous', title: 'Continuous experiments', start: '2026-11-18' };
  const validate = change => validateProject({ ...exampleProject, phases: [{ ...phase, ...change }] });
  assert.deepEqual(validate().phases, [phase]);
  assert.equal(validate({ end: null }).phases[0].end, null);
  assert.equal(validate({ end: phase.start }).phases[0].end, phase.start);
  assert.throws(() => validate({ start: undefined }), /\.start must be a real calendar date/);
  assert.throws(() => validate({ end: '2026-11-31' }), /\.end must be a real calendar date/);
  assert.throws(() => validate({ end: '2026-11-17' }), /\.end must be on or after its start/);
});

test('describe gives a fresh agent the stage decision, latest summary and three recent experiments', async t => {
  const project = structuredClone(exampleProject);
  project.phases = [{ id: 'review', title: '复测', start: '2000-01-01', description: '确认不同机位能否复现计时差异。' }];
  const runs = ['a', 'b', 'c', 'd'].map((id, i) => ({
    id, type: 'experiment', title: id, date: '2000-01-0' + (i + 1), phaseId: 'review',
    fields: { scene: 'Forest' }, body: '本轮记录。',
  }));
  const root = await projectFolder(t);
  await ResearchStore.initialize(root, project, [...runs,
    { ...runs[0], id: 'future', date: '2999-01-01' },
    { id: 'summary', type: 'stage-summary', title: '阶段复核', date: '2000-01-04',
      coverage: { start: '2000-01-01', end: '2000-01-04' }, body: '## 结论\n\n两轮使用相同机位。' },
  ]);
  const describe = JSON.parse(require('node:child_process').execFileSync(process.execPath,
    [require.resolve('../electron/research-cli.cjs'), 'describe', root], { encoding: 'utf8' }));
  const [phase] = describe.phaseContext;
  assert.equal(phase.phaseId, 'review');
  assert.equal(phase.description, project.phases[0].description);
  assert.equal(phase.latestSummary.excerpt, '两轮使用相同机位。');
  assert.deepEqual(phase.recentExperiments.map(item => item.id), ['d', 'c', 'b']);
  const guide = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(guide.includes(describe.format.rules.phaseSelection));
  assert.ok(guide.includes(describe.format.rules.experimentReport));
  for (const type of describe.project.recordTypes.filter(type => type.kind === 'entry' || type.kind === 'summary')) {
    const headings = type.template.split('\n').filter(line => line.startsWith('## '));
    assert.equal(headings[0], '## 结论');
    assert.equal(headings.at(-1), '## 待验证');
  }
});

test('summary excerpts prefer the project’s conclusion field, then a conclusion section, then the first prose sentence', async t => {
  const project = structuredClone(exampleProject);
  const type = project.recordTypes.find(type => type.kind === 'summary');
  type.conclusionField = 'finding';
  type.fields = [{ id: 'finding', label: 'Finding', type: 'text' }];
  const store = await ResearchStore.initialize(await projectFolder(t), project, exampleRecords);
  const original = await store.read('exploration-review');
  const body = '# Report\n\nBackground. More context.\n\n## Conclusion\n\nA measured result. Other detail.';
  const latest = async () => (await store.snapshot()).records.find(item => item.record.id === original.record.id).excerpt;
  const update = async change => store.writeBatch({ records: [{ id: original.record.id, ifRevision: (await store.read(original.record.id)).revision, ...change }] });
  await update({ body, fields: { finding: '项目自定义结论。还有细节。' } });
  assert.equal(await latest(), '项目自定义结论。');
  await update({ fields: { finding: null } });
  assert.equal(await latest(), 'A measured result.');
  const appendix = ['~~~md', '## Findings', 'Example finding.', '~~~', '## Measurements', 'observations '.repeat(900), '## Findings', '### Timing', '- Frame time is 11.8 ms. More detail.'];
  await update({ body: [body.split('## Conclusion')[0], ...appendix].join('\n\n') });
  assert.equal(await latest(), 'Frame time is 11.8 ms.');
  await update({ body: '# Report\n\nBackground. Other detail.\n\n## Findings\n\n## References\n\nAn unrelated source.' });
  assert.equal(await latest(), 'Background.');
  await update({ body: '# Report\n\nBackground. More context.' });
  assert.equal(await latest(), 'Background.');
  type.conclusionField = 'missing';
  assert.throws(() => validateProject(project), /conclusionField/);
});

test('experiment previews use the project conclusion or find it in older reports', async t => {
  const project = structuredClone(exampleProject);
  const type = project.recordTypes.find(type => type.kind === 'entry');
  type.fields.push({ id: 'reading', label: '研究判断', type: 'text' });
  type.conclusionField = 'reading';
  const store = await ResearchStore.initialize(await projectFolder(t), project);
  const item = { id: 'rerun', type: type.id, title: '复核', date: '2000-01-01', fields: { scene: '树林' } };
  const excerpt = async () => (await store.snapshot()).records[0].excerpt;
  await store.writeBatch({ records: [item] });
  assert.equal(await excerpt(), undefined);
  const body = '# 复核\n\n使用第二个机位。\n\n## 结论与下一步\n\n需要补测同机位的基线。';
  const update = async change => store.writeBatch({ records: [{ id: item.id, ifRevision: (await store.read(item.id)).revision, ...change }] });
  await update({ body });
  assert.equal(await excerpt(), '使用第二个机位。');
  await update({ fields: { reading: '已取得同机位对照。测量如下。' } });
  assert.equal(await excerpt(), '已取得同机位对照。');
  await update({ fields: { reading: null }, body: '# 复核\n\n林间步道测得 11.4 ms。稍后补对照。' });
  assert.equal(await excerpt(), '林间步道测得 11.4 ms。');
});

test('phase and record previews omit open questions and keep confirmed findings across nested headings', async t => {
  const { store } = await archiveProject(t);
  const record = await store.read('exploration-review');
  const preview = async body => {
    const current = await store.read(record.record.id);
    await store.writeBatch({ records: [{ id: current.record.id, ifRevision: current.revision, body }] });
    return (await store.snapshot()).records.find(item => item.record.id === current.record.id).excerpt;
  };
  assert.equal(await preview('# 复核\n\n## 结论\n\n### 待验证\n\n补测另一机位。\n\n#### 结论\n\n可能仍然省时。'), undefined);
  assert.equal(await preview('## Open questions\n\n### Findings\n\nThe camera might matter.\n\n## Measurements\n\nThe median was 11 ms.'), 'The median was 11 ms.');
  assert.equal(await preview('## 结论与下一步\n\n再跑一次。\n\n## 已确认的结论\n\n### 测量\n\n- 同机位用时缩短 12%。\n\n## 待验证\n\n换机位复核。'), '同机位用时缩短 12%。');
});

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

test('field definitions follow each written value across configuration changes, retries and raw editor saves', async t => {
  const store = await ResearchStore.initialize(await projectFolder(t), exampleProject, exampleRecords);
  const first = await store.read('forest-validation');
  assert.equal(first.fieldOrigins.gpu_ms.rule.unit, 'ms');
  assert.equal(first.fieldOrigins.gpu_ms.source, 'record');
  assert.equal(first.fieldOrigins.gpu.source, 'default');
  const { project, revision } = await store.manifest();
  const type = project.recordTypes.find(type => type.id === first.record.type);
  type.fields.find(rule => rule.id === 'gpu_ms').description = 'Revised timing protocol.';
  type.fields = type.fields.filter(rule => rule.id !== 'gpu');
  type.template = type.template.replace('{{field.gpu}}', '');
  await store.configure({ ifRevision: revision, project });
  const read = () => store.read(first.record.id);
  const batch = (record, patch) => store.writeBatch({ records: [{ id: record.record.id, ifRevision: record.revision, ...patch }] });
  await batch(first, { body: 'Revised notes.' });
  const note = await read();
  assert.equal(note.record.fieldRules, first.record.fieldRules);
  assert.deepEqual(note.fieldOrigins, first.fieldOrigins);
  await batch(note, { fields: { gpu_ms: 13 } });
  assert.equal((await batch(note, { fields: { gpu_ms: 13 } })).records[0].changed, false);
  const revised = await read();
  assert.equal(revised.fieldOrigins.gpu_ms.rule.description, 'Revised timing protocol.');
  assert.deepEqual(revised.fieldOrigins.gpu, first.fieldOrigins.gpu);
  const file = path.join(store.root, revised.relativePath);
  const disk = await fs.readFile(file, 'utf8');
  const edit = { path: file, revision: revised.revision, content: disk.replace('"gpu_ms": 13', '"gpu_ms": 14') };
  let saved;
  await store.saveDocument(edit, async document => { saved = document.content; await fs.writeFile(file, saved); });
  assert.equal((await read()).record.fields.gpu_ms, 14);
  assert.equal((await read()).fieldOrigins.gpu_ms.rule.description, 'Revised timing protocol.');
  await fs.writeFile(file, saved.replace('"gpu_ms": 14', '"gpu_ms": 15'));
  const external = await read();
  assert.equal(external.fieldOrigins.gpu_ms, undefined);
  assert.deepEqual(external.fieldOrigins.gpu, first.fieldOrigins.gpu);
  await batch(external, { fields: { gpu: null } });
  const cleared = await read();
  assert.equal(cleared.fieldOrigins?.gpu, undefined);
  assert.equal(cleared.fieldOrigins?.gpu_ms, undefined);
  const original = await store.read('baseline-city');
  await fs.unlink(path.join(store.root, '.mekir/field-rules', original.record.fieldRules + '.json'));
  assert.equal((await store.read('baseline-city')).fieldOrigins, undefined);
  assert.match((await store.read('baseline-city')).body, /12\.8/);
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

test('phase image comparisons keep indexed references, Markdown and a distinct record type', async t => {
  const { store, directory } = await archiveProject(t);
  await fs.writeFile(path.join(directory, 'render.png'), Buffer.from('original image fixture'));
  await fs.writeFile(path.join(directory, 'notes.txt'), 'A non-image reference');
  await store.bindEvidenceSource('renders', directory, 'Renders');
  await store.indexEvidence('render', { sourceId: 'renders', relativePath: 'render.png', title: 'Original image' });
  await store.indexEvidence('notes', { sourceId: 'renders', relativePath: 'notes.txt', title: 'Notes' });
  const before = await store.manifest();
  await store.configure({ ifRevision: before.revision, project: { ...before.project, recordTypes: [
    ...before.project.recordTypes, { id: 'image-comparison', label: 'Existing type', kind: 'entry', fields: [], template: '' },
  ] } });
  const discovery = await store.snapshot();
  assert.equal(discovery.comparisonType.id, 'image-comparison-2');
  const change = { id: 'comparison', ifRevision: null, type: discovery.comparisonType.id, title: 'Comparison', date: '2026-11-18',
    phaseId: 'validation', body: '**Fixed camera**', comparison: { columns: ['Mesh', 'Ours'], rows: [{ label: 'Camera', images: ['render', null] }] } };
  const save = records => store.writeBatch({ ifProjectRevision: discovery.revision, records });
  await assert.rejects(save([{ ...change, comparison: { columns: ['Mesh', 'Ours'], rows: [{ label: 'Camera', images: ['render'] }] } }]), /one image slot per column/);
  await assert.rejects(save([{ ...change, comparison: { columns: ['Mesh'], rows: [{ label: 'Camera', images: ['notes'] }] } }]), /indexed image evidence/);
  assert.equal((await store.manifest()).revision, discovery.revision);
  const written = await save([change]);
  const stored = await store.read(change.id);
  assert.deepEqual(stored.record.comparison, change.comparison);
  assert.equal(stored.body, change.body);
  assert.equal((await store.manifest()).project.recordTypes.at(-1).kind, 'comparison');
  const repeat = await store.writeBatch({ ifProjectRevision: written.projectRevision, records: [change] });
  assert.equal(repeat.records[0].changed, false);
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

test('only summaries can name multiple other project IDs and expose their metadata to each target', async t => {
  const root = await projectFolder(t);
  const store = await ResearchStore.initialize(root, exampleProject, exampleRecords);
  const { record, revision } = await store.read('exploration-review');
  const update = { id: record.id, ifRevision: revision };
  await assert.rejects(store.writeBatch({ records: [{ ...update, relatedProjects: [exampleProject.id] }] }), /original project/);
  const experiment = await store.read('tile-culling');
  await assert.rejects(store.writeBatch({ records: [{ id: experiment.record.id, ifRevision: experiment.revision,
    relatedProjects: ['paper'] }] }), /Only phase summaries/);
  await store.writeBatch({ records: [{ ...update, relatedProjects: ['paper', 'reference-runs'] }] });

  const paper = await store.linkedSummaries('paper', exampleProject);
  const references = await store.linkedSummaries('reference-runs', exampleProject, { query: '遮挡边缘' });
  assert.deepEqual(paper, references);
  assert.equal(paper[0].relativePath, '.mekir/summaries/r-exploration-review.md');
  assert.deepEqual(paper[0].record.relatedProjects, ['paper', 'reference-runs']);
  assert.deepEqual(await store.linkedSummaries('unrelated', exampleProject), []);
});

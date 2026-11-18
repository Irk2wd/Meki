import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const folder = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'research-')));
const project = path.join(folder, 'research-example');
const archive = path.join(folder, 'unilod-archive');
const archiveRun = path.join(archive, 'performance', '20261117_final30000');
const canopy = path.join(archiveRun, 'figures', 'canopy.png');
const cli = path.join(root, 'electron', 'research-cli.cjs');
const env = {
  ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(folder, 'profile'),
  MEKIR_LOCAL_STATE: path.join(folder, 'local-state'), MEKI_TEST_EVIDENCE_FOLDER: archive, MEKI_TEST_EVIDENCE_FILE: canopy,
  MEKI_TEST_RESEARCH_PARENT: folder, MEKI_TEST_FOLDER_PATH: project, MEKI_TEST_CONFLICT: 'cancel', MEKI_TEST_DISCARD: 'discard',
};
delete env.ELECTRON_RUN_AS_NODE;

function command(name, args = [], input, errorPattern) {
  const result = spawnSync(process.execPath, [cli, name, project, ...args, ...(input ? ['--input', '-'] : [])], {
    input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MEKIR_LOCAL_STATE: env.MEKIR_LOCAL_STATE },
  });
  if (errorPattern) {
    assert.equal(result.status, 1, result.stdout || String(result.error));
    assert.match(JSON.parse(result.stderr).error, errorPattern);
    return;
  }
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

let app, page;
const results = [], errors = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function closeReader() {
  await page.locator('[data-action="research-close-reader"]').click();
  await page.locator('#document-surface').waitFor({ state: 'hidden' });
  await idle();
}
async function launch() {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'),
    args: process.env.MEKI_EXECUTABLE ? [] : [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]');
}
async function sourceAppend(text) {
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText(text);
}

try {
  await launch();
  await page.getByRole('heading', { name: '科研项目', exact: true }).waitFor();
  await page.locator('#document-surface').waitFor({ state: 'hidden' });
  await page.locator('#workspace-switch').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '创建示例项目', exact: true }).click();
  await page.getByRole('heading', { name: '实时渲染性能研究', exact: true }).waitFor();
  await idle();
  await app.close();
  app = undefined;
  await launch();
  await page.getByRole('heading', { name: '实时渲染性能研究', exact: true }).waitFor();
  await page.locator('[data-research-destination=timeline][aria-current=page]').waitFor();
  await page.locator('[data-action="research-projects"]').first().click();
  const projectPicker = page.locator('#research-project-picker');
  await projectPicker.getByRole('button', { name: /实时渲染性能研究/ }).waitFor();
  await projectPicker.getByRole('button', { name: '创建示例项目', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await projectPicker.waitFor({ state: 'hidden' });
  pass('fresh and resumed windows start in the project shell, with project-only switching');
  assert.equal(command('describe').format.manifest, '.mekir/project.json');
  assert.equal(command('read', ['exploration-review']).relativePath, '.mekir/summaries/r-exploration-review.md');
  assert.equal(command('read', ['tile-culling']).relativePath, 'records/r-tile-culling.md');
  assert.ok((await page.evaluate(() => window.meki.refreshWorkspace())).tree.every(entry => !entry.relativePath.startsWith('.mekir')));
  const phases = page.locator('.research-timeline [data-research-phase]');
  const phaseOrder = () => phases.evaluateAll(rows => rows.map(row => row.dataset.researchPhase));
  const refresh = page.getByRole('button', { name: '刷新项目', exact: true });
  await page.clock.setFixedTime(new Date('2026-11-17T12:00:00+08:00'));
  await refresh.click();
  await idle();
  assert.deepEqual(await phaseOrder(), ['validation', 'exploration', 'baseline']);
  assert.match(await phases.first().innerText(), /进行中/);
  await page.clock.setFixedTime(new Date('2026-11-19T12:00:00+08:00'));
  await refresh.click();
  await idle();
  assert.deepEqual(await phaseOrder(), ['exploration', 'validation', 'baseline']);
  assert.match(await phases.first().innerText(), /最近进展 11\/16/);
  assert.equal(await page.locator('.research-timeline [data-research-record]').count(), 0);
  pass('phase order prioritizes ongoing dates and then the latest activity, including summaries');

  const rangeButton = page.locator('[data-research-range]');
  const rangePicker = page.getByRole('dialog', { name: '选择时间范围' });
  const applyRange = rangePicker.getByRole('button', { name: '应用' });
  await rangeButton.click();
  await rangePicker.getByLabel('开始日期').fill('2026-11-10');
  await rangePicker.getByLabel('结束日期').fill('2026-11-08');
  await applyRange.click();
  await rangePicker.getByRole('alert').filter({ hasText: '结束日期不能早于开始日期。' }).waitFor();
  await rangePicker.getByLabel('结束日期').fill('2026-11-14');
  await applyRange.click();
  assert.deepEqual(await phaseOrder(), ['exploration', 'validation']);
  assert.equal(await page.locator('.research-entry').count(), 2);
  assert.equal(await page.locator('[data-research-record=tile-culling]').count(), 0);
  assert.equal(await phases.first().locator('.research-timeline-bar').evaluate(bar => bar.style.getPropertyValue('--left')), '0%');
  await page.locator('[data-research-reset-range]').click();

  const ruler = page.locator('[data-research-axis]');
  const bounds = await ruler.boundingBox();
  const x = day => bounds.x + bounds.width * (day - 2 + 0.5) / 17;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x(14), y);
  await page.mouse.down();
  await page.mouse.move(x(5), y, { steps: 4 });
  await page.mouse.up();
  assert.match(await rangeButton.innerText(), /2026-11-05 – 2026-11-14/);
  assert.equal(await page.locator('.research-entry').count(), 3);
  pass('date range selection and axis drag clip coverage and filter experiments');

  const tile = command('read', ['tile-culling']);
  const filler = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 次记录依次检查相机轨迹、可见性与帧时间。`).join('\n\n');
  command('batch', [], { records: [{ id: tile.record.id, ifRevision: tile.revision, body: `${tile.body}\n${filler}\n\n[城市街区基线](mekir:baseline-city)\n` }] });
  await refresh.click();
  await idle();
  await page.locator('[data-research-phase="exploration"]').click();
  assert.equal(await page.locator('.research-entry').count(), 2);
  const phaseSummary = page.locator('.research-phase-summaries [data-research-record=exploration-review]');
  assert.match(await phaseSummary.innerText(), /覆盖 2026-11-05 – 2026-11-13 · 撰写于 2026-11-16/);
  await page.locator('#research-date').fill('2026-11-07');
  assert.equal(await page.locator('.research-entry').count(), 1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 490));
  await phaseSummary.scrollIntoViewIfNeeded();
  const researchScroll = page.locator('.research-content');
  const scroll = await researchScroll.evaluate(element => element.scrollTop);
  assert.ok(scroll > 0);
  await phaseSummary.click();
  await page.locator('#research-reader-title').getByText('方案探索阶段总结', { exact: true }).waitFor();
  assert.equal(await page.locator('#visual-editor .ProseMirror').getAttribute('contenteditable'), 'false');
  await page.locator('#visual-editor a[href="mekir:tile-culling"]').click();
  await page.locator('#research-reader-title').getByText('测试分块遮挡剔除', { exact: true }).waitFor();
  await idle();
  const baselineLink = page.locator('#visual-editor a[href="mekir:baseline-city"]');
  await baselineLink.scrollIntoViewIfNeeded();
  const documentScroll = page.locator('#document-scroll');
  const tileScroll = await documentScroll.evaluate(element => element.scrollTop);
  assert.ok(tileScroll > 0);
  await baselineLink.click();
  const readerTitle = page.locator('#research-reader-title');
  await readerTitle.getByText('城市街区基线', { exact: true }).waitFor();
  const back = page.getByRole('button', { name: '返回上一份文档' });
  await back.click();
  await readerTitle.getByText('测试分块遮挡剔除', { exact: true }).waitFor();
  assert.equal(await documentScroll.evaluate(element => element.scrollTop), tileScroll);
  await back.click();
  await readerTitle.getByText('方案探索阶段总结', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回研究列表' }).click();
  await page.locator('#document-surface').waitFor({ state: 'hidden' });
  assert.equal(await researchScroll.evaluate(element => element.scrollTop), scroll);
  assert.equal(await page.locator('#research-date').inputValue(), '2026-11-07');
  assert.match(await rangeButton.innerText(), /2026-11-05 – 2026-11-14/);
  assert.equal(await page.locator('[data-research-phase="exploration"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await phaseSummary.evaluate(button => document.activeElement === button), true);
  pass('linked read-only previews return document by document and restore scroll, focus and timeline filters');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820));
  await page.locator('[data-research-reset-range]').click();

  await page.locator('#research-date').fill('2026-11-10');
  assert.equal(await page.locator('.research-entry').count(), 0);
  await page.getByRole('button', { name: '新建研究记录' }).click();
  const dialog = page.locator('#research-record-dialog');
  assert.equal(await dialog.locator('[name=date]').inputValue(), '2026-11-10');
  await dialog.locator('[name=title]').fill('检查 GPU 帧时间统计');
  assert.equal(await dialog.locator('[name=phaseId]').inputValue(), 'exploration');
  await dialog.locator('[name=field-scene]').fill('City Block');
  await dialog.locator('[name=field-gpu_ms]').fill('10.5');
  await dialog.getByRole('button', { name: '创建并编辑' }).click();
  await page.locator('#visual-editor h1').filter({ hasText: '检查 GPU 帧时间统计' }).waitFor();
  await idle();
  const manual = command('list', ['--from', '2026-11-10', '--to', '2026-11-10']).records[0].record;
  assert.equal(manual.fields.gpu_ms, 10.5);
  await sourceAppend('\n在 Meki 中完成记录。');
  await page.locator('[data-action=save]').click();
  await idle();
  assert.match(command('read', [manual.id]).body, /在 Meki 中完成记录/);
  pass('date filter, configured form, Markdown template and mekiR editing');

  const notes = path.join(project, 'notes');
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, '测量方法.md'), '# 测量方法\n\n使用固定镜头轨迹。\n');
  assert.equal(command('index', ['measurement-notes', '--path', 'notes/测量方法.md']).id, 'measurement-notes');
  await closeReader();
  await page.locator('#research-date').fill('');
  await page.getByRole('button', { name: '插入阶段总结' }).click();
  await dialog.locator('[name=title]').fill('阈值阶段回顾');
  await dialog.locator('[name=date]').fill('2026-11-17');
  assert.equal(await dialog.locator('[name=start]').inputValue(), '2026-11-05');
  assert.equal(await dialog.locator('[name=end]').inputValue(), '2026-11-13');
  await dialog.getByText('关联来源文档', { exact: true }).click();
  await dialog.locator(`[name=source][value="${manual.id}"]`).check();
  await dialog.locator('[name=source][value=measurement-notes]').check();
  await dialog.getByRole('button', { name: '创建并编辑' }).click();
  await page.locator('#visual-editor h1').filter({ hasText: '阈值阶段回顾' }).waitFor();
  await idle();
  const summary = command('list', ['--from', '2026-11-17', '--type', 'stage-summary']).records[0].record;
  assert.deepEqual(summary.coverage, { start: '2026-11-05', end: '2026-11-13' });
  assert.deepEqual(summary.sources, [manual.id, 'measurement-notes']);
  const written = command('read', [summary.id]);
  assert.equal(written.relativePath, `.mekir/summaries/r-${summary.id}.md`);
  assert.ok(written.body.includes(`(mekir:${manual.id})`));
  await sourceAppend('\n阶段总结正文已保存。');
  await page.locator('[data-action=save]').click();
  await idle();
  const summaryBody = command('read', [summary.id]).body;
  assert.match(summaryBody, /阶段总结正文已保存/);
  assert.ok(summaryBody.includes('(mekir:measurement-notes)'));

  const rename = await page.evaluate(notes => window.meki.workspaceOperation({ action: 'rename', path: notes, name: 'materials' }), notes);
  assert.equal(rename.path, path.join(project, 'materials'));
  assert.equal(rename.warning, undefined);
  assert.equal(command('resolve', ['measurement-notes']).relativePath, 'materials/测量方法.md');
  assert.equal(command('read', [summary.id]).body, summaryBody);
  await page.locator('[data-mode=visual]').click();
  await page.locator('#visual-editor a[href="mekir:measurement-notes"]').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await page.locator('#visual-editor h1').filter({ hasText: '测量方法' }).waitFor();
  await idle();
  await closeReader();
  await page.locator('.research-phase-summaries').getByText('阈值阶段回顾', { exact: true }).waitFor();
  await page.locator(`[data-research-edit="${summary.id}"]`).click();
  await dialog.locator('[name=end]').fill('2026-11-12');
  await dialog.getByRole('button', { name: '保存属性' }).click();
  await page.locator('.research-phase-summaries').getByText(/覆盖 2026-11-05 – 2026-11-12/).waitFor();
  assert.equal(command('read', [summary.id]).record.coverage.end, '2026-11-12');
  pass('hidden summaries, indexed Markdown links, workspace rename and timeline coverage');

  const discovery = command('describe');
  const config = discovery.project;
  assert.equal(config.recordTypes.find(type => type.id === 'experiment').fields.find(field => field.id === 'gpu_ms').min, 0);
  const experiment = config.recordTypes.find(type => type.id === 'experiment');
  experiment.fields.push({ id: 'build', label: '渲染构建', type: 'text', required: true, description: '渲染器 commit 或制品 ID。' });
  experiment.template += '\n## 渲染构建\n\n{{field.build}}\n';
  config.views.push({ id: 'verification', label: '复测结果', layout: 'journal', order: 'newest', typeIds: ['experiment'], phaseIds: ['validation'], fieldIds: ['build', 'gpu_ms'] });
  config.defaultView = 'verification';
  config.phases.find(phase => phase.id === 'validation').end = '2026-11-19';
  command('configure', [], { ifRevision: discovery.revision, project: config });
  const updated = command('describe');
  assert.notEqual(updated.revision, discovery.revision);
  const original = command('read', [manual.id]);
  const run = {
    id: 'agent-verification', type: experiment.id, title: 'Agent 批次复测', date: '2026-11-18', phaseId: 'validation',
    fields: { ...original.record.fields, gpu_ms: 10.4, outcome: '有效', build: 'render-9c217' },
  };
  command('batch', [], { records: [run, { ...run, id: 'invalid-run', date: '2026-02-30' }] }, /real calendar date/);
  await assert.rejects(fs.access(path.join(project, 'records', 'r-agent-verification.md')), { code: 'ENOENT' });
  command('batch', [], { records: [{ ...run, fields: { ...run.fields, gpu_ms: -1 } }] }, /at least 0/);
  const batch = { ifProjectRevision: updated.revision, records: [
    { id: manual.id, ifRevision: original.revision, fields: { build: 'render-9c217' } },
    run,
    { id: 'agent-review', type: 'stage-summary', title: 'Agent 复测总结', phaseId: 'validation', date: '2026-11-19',
      coverage: { start: '2026-11-12', end: '2026-11-18' }, sources: [run.id, manual.id] },
  ] };
  assert.deepEqual(command('batch', [], batch).records.map(item => item.changed), [true, true, true]);
  assert.deepEqual(command('batch', [], batch).records.map(item => item.changed), [false, false, false]);
  assert.equal(command('read', [manual.id]).body, original.body);
  assert.match(command('read', [run.id]).body, /render-9c217/);
  assert.match(command('read', ['agent-review']).body, /mekir:agent-verification/);
  await page.getByRole('button', { name: '复测结果', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '复测结果', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.locator('.research-entry-title [data-research-record=agent-verification]').waitFor();
  assert.equal(await page.locator('.research-entry').count(), 2);
  assert.match(await page.locator('.research-entry-meta').first().innerText(), /渲染构建 render-9c217/);
  await page.getByRole('button', { name: '新建研究记录' }).click();
  assert.equal(await dialog.locator('[name=field-build]').getAttribute('required'), '');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  pass('CLI rule discovery, batch validation and retry, project fields, templates and views refreshed in mekiR');

  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.locator('[data-research-phase=validation]').click();
  await page.locator('.research-phase-summaries').getByText('Agent 复测总结', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(folder, 'timeline.png'), animations: 'disabled' });
  await page.locator('.research-entry-title [data-research-record=agent-verification]').click();
  await page.locator('#visual-editor h1').filter({ hasText: 'Agent 批次复测' }).waitFor();
  await idle();
  await page.locator('[data-action=research-edit-body]').click();
  assert.equal(await page.locator('#visual-editor .ProseMirror').getAttribute('contenteditable'), 'true');
  await sourceAppend('\n一份尚未保存的人工修改。');
  await page.locator('#research-reader-context').getByText(/未保存/).waitFor();
  const disk = command('read', [run.id]);
  command('batch', [], { records: [{ id: run.id, ifRevision: disk.revision, body: disk.body + '\nAgent 写入的新结果。\n' }] });
  await page.locator('#external-banner').waitFor();
  command('batch', [], { records: [{ id: run.id, ifRevision: disk.revision, body: 'Stale update' }] }, /changed/);
  await page.locator('[data-action=save]').click();
  await idle();
  assert.match(await page.locator('#source-editor .cm-content').innerText(), /尚未保存的人工修改/);
  assert.match(command('read', [run.id]).body, /Agent 写入的新结果/);
  await closeReader();
  await page.locator('[data-research-record=agent-verification]').click();
  await page.locator('#source-editor .cm-content').getByText(/尚未保存的人工修改/).waitFor();
  pass('concurrent agent edits preserve disk changes and the unsaved mekiR draft');

  await closeReader();
  await fs.mkdir(path.dirname(canopy), { recursive: true });
  await fs.mkdir(path.join(archive, 'performance', '20261112_final3000'));
  await fs.writeFile(canopy, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT4sAAAAASUVORK5CYII=', 'base64'));
  await fs.writeFile(path.join(archiveRun, 'RUN.md'), '# 森林四视角报告\n\n## 研究问题\n比较树冠剔除前后的帧时间。\n');
  await fs.writeFile(path.join(archiveRun, 'timings.csv'), 'round,gpu_ms\n1,10.9\n');
  await fs.writeFile(path.join(archiveRun, 'run_manifest.json'), JSON.stringify({ run_id: 'final30000', created_at: '2026-11-17',
    model: 'Electric Dreams', camera: '固定四视角', protocol: '同模型同相机逐轮计时' }));
  await page.locator('[data-research-destination=sources]').click();
  const tools = page.locator('#research-tools-dialog');
  await page.getByRole('button', { name: '登记只读来源' }).click();
  await tools.getByLabel('来源名称').fill('F 盘实验证据');
  await tools.getByLabel('来源 ID').fill('archive');
  await tools.getByRole('button', { name: '选择目录并绑定' }).click();
  await page.locator('.research-source-folder').getByText('F 盘实验证据').waitFor();
  await page.locator('[data-research-index-evidence=archive]').click();
  await tools.getByLabel('证据 ID').fill('forest-canopy');
  await tools.getByLabel('证据名称').fill('树冠原图');
  await tools.getByRole('button', { name: '选择文件并登记' }).click();
  await tools.waitFor({ state: 'hidden' });
  assert.equal(command('resolve', ['forest-canopy', '--local']).path, canopy);
  await page.locator('[data-research-import=archive]').click();
  await tools.getByText(/新增 2 .*1 个运行有缺件/).waitFor();
  await tools.getByText(/待补报告/).waitFor();
  await tools.getByRole('button', { name: '确认导入 2 条记录' }).click();
  await tools.waitFor({ state: 'hidden' });
  const runs = command('list', ['--type', 'archive-run']).records;
  const final = runs.find(({ record }) => record.run.id === 'final30000');
  const prior = runs.find(({ record }) => record.run.missing.includes('RUN.md'));
  assert.equal(runs.length, 2);
  assert.ok(command('import-archive', ['archive']).runs.every(item => item.change === 'unchanged'));
  const paper = path.join(folder, 'paper-repo');
  await fs.mkdir(paper);
  await fs.writeFile(path.join(paper, 'method.tex'), '\\section{Four-view validation}\n');
  command('bind-source', ['paper', '--path', paper, '--label', '论文仓库']);
  command('index', ['paper-v3', '--source', 'paper', '--path', 'method.tex', '--label', '论文 v3']);
  command('batch', [], { records: [{ id: 'paper-decision', type: 'stage-summary', title: '森林结果采用决定', date: '2026-11-19',
    coverage: { start: '2026-11-12', end: '2026-11-18' }, body: '# 森林结果采用决定\n\n[树冠原图](mekir:forest-canopy)\n',
    relations: [{ kind: 'paper-adopted', target: final.record.id, note: '固定四视角并报告逐轮计时。' },
      { kind: 'compares', target: prior.record.id }] }] });
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await idle();
  await page.locator('[data-research-destination=entries]').click();
  await page.getByText('待补报告', { exact: true }).waitFor();
  await page.locator('[data-research-filter]').click();
  await tools.getByLabel('关键词').fill('Electric Dreams ＋ 性能 ＋ 11 月');
  await tools.getByRole('button', { name: '添加字段条件' }).click();
  await tools.getByLabel('筛选字段').selectOption('run.camera');
  await tools.getByLabel('匹配值').fill('四视角');
  await tools.getByLabel('筛选名称').fill('四视角性能');
  await tools.getByRole('button', { name: '保存并应用' }).click();
  await page.locator('.research-active-filter').getByText(/相机 = 四视角/).waitFor();
  assert.equal(await page.locator('.research-entry').count(), 1);
  await page.locator('[data-research-clear]').click();
  await page.locator('.research-active-filter').waitFor({ state: 'hidden' });
  await page.locator('[data-research-filter]').click();
  await tools.getByLabel('已保存的筛选').selectOption({ label: '四视角性能' });
  await tools.getByRole('button', { name: '应用', exact: true }).click();
  await page.locator('.research-active-filter').getByText(/相机 = 四视角/).waitFor();
  assert.equal(await page.locator('.research-entry').count(), 1);
  pass('the app binds and indexes sources, previews imports with missing reports, and saves combined research filters');

  await page.locator('[data-research-clear]').click();
  await page.locator('[data-research-destination=summaries]').click();
  await page.locator('[data-research-edit=paper-decision]').click();
  await dialog.getByText('原始证据与研究关系', { exact: true }).click();
  await dialog.getByRole('button', { name: '添加研究关系' }).click();
  await dialog.locator('[name=relation-kind]').last().selectOption('paper-version');
  await dialog.locator('[name=relation-target]').last().fill('paper-v3');
  await dialog.getByRole('button', { name: '保存属性' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(command('read', ['paper-decision']).record.relations.at(-1).target, 'paper-v3');
  await page.locator('[data-research-record=paper-decision]').click();
  const related = page.locator('#research-reader-related');
  await related.getByText('固定四视角并报告逐轮计时。').waitFor();
  await page.locator('#visual-editor a[href="mekir:forest-canopy"]').click();
  await tools.getByRole('heading', { name: '树冠原图' }).waitFor();
  await tools.locator('img').evaluate(async image => { await image.decode(); });
  await tools.getByRole('button', { name: '返回正文' }).click();
  await related.getByRole('button', { name: '论文 v3' }).click();
  await tools.locator('pre').getByText(/Four-view validation/).waitFor();
  await tools.getByRole('button', { name: '返回正文' }).click();
  await related.getByRole('button', { name: '森林四视角报告' }).click();
  await page.locator('#research-reader-title').getByText('森林四视角报告').waitFor();
  await related.getByRole('button', { name: 'timings.csv', exact: true }).click();
  await tools.locator('pre').getByText(/10\.9/).waitFor();
  await tools.getByRole('button', { name: '返回正文' }).click();
  await related.getByRole('button', { name: 'run_manifest.json', exact: true }).click();
  await tools.locator('pre').getByText(/Electric Dreams/).waitFor();
  await tools.getByRole('button', { name: '返回正文' }).click();
  await page.getByRole('button', { name: '返回上一份文档' }).click();
  await page.locator('#research-reader-title').getByText('森林结果采用决定').waitFor();
  await page.screenshot({ path: path.join(folder, 'research-evidence.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  pass('adoption decisions link back to comparable runs, manuscript versions and read-only images, CSV and manifests');
  await fs.writeFile(path.join(folder, 'results.json'), JSON.stringify({ results, errors }, null, 2) + '\n');
  console.log(`Timeline screenshot: ${path.join(folder, 'timeline.png')}`);
} finally {
  if (app) {
    await app.evaluate(({ app, BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.quit(); }).catch(() => {});
    await app.close().catch(() => {});
  }
}

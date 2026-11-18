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
const project = path.join(folder, 'meki-render-research');
const cli = path.join(root, 'electron', 'research-cli.cjs');
const env = {
  ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(folder, 'profile'),
  MEKI_TEST_RESEARCH_PARENT: folder, MEKI_TEST_FOLDER_PATH: project, MEKI_TEST_CONFLICT: 'cancel', MEKI_TEST_DISCARD: 'discard',
};
delete env.ELECTRON_RUN_AS_NODE;

function command(name, args = [], input, errorPattern) {
  const result = spawnSync(process.execPath, [cli, name, project, ...args, ...(input ? ['--input', '-'] : [])], {
    input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', timeout: 10000,
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
const errors = [];
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function showProject() {
  await page.locator('[data-action="research"]').click();
  await page.getByRole('heading', { name: '实时渲染性能研究', exact: true }).waitFor();
}
async function sourceAppend(text) {
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText(text);
}

try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'),
    args: process.env.MEKI_EXECUTABLE ? [] : [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]');
  await page.locator('[data-action="research"]').click();
  await page.getByRole('button', { name: '创建渲染研究示例' }).click();
  await page.getByRole('heading', { name: '实时渲染性能研究', exact: true }).waitFor();
  await idle();
  assert.equal(await page.locator('.research-timeline [data-research-phase]').count(), 3);
  const summaries = page.locator('.research-timeline-summary');
  assert.match(await summaries.first().innerText(), /撰写于.*16/);
  assert.match(await summaries.first().innerText(), /5.*13/);
  await page.locator('[data-research-phase="exploration"]').click();
  assert.equal(await page.locator('.research-entry').count(), 3);
  await page.locator('[data-research-clear]').click();
  await page.locator('#research-date').fill('2026-11-10');
  assert.equal(await page.locator('.research-entry').count(), 0);
  await page.getByRole('button', { name: '新建研究记录' }).click();
  const dialog = page.locator('#research-record-dialog');
  assert.equal(await dialog.locator('[name=date]').inputValue(), '2026-11-10');
  await dialog.locator('[name=title]').fill('检查 GPU 帧时间统计');
  await dialog.locator('[name=phaseId]').selectOption('exploration');
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
  console.log('PASS date filter, configured form, Markdown template and Meki editing');

  await showProject();
  await page.locator('[data-research-clear]').click();
  await page.locator('[data-research-phase="exploration"]').click();
  await page.getByRole('button', { name: '插入阶段总结' }).click();
  await dialog.locator('[name=title]').fill('阈值阶段回顾');
  await dialog.locator('[name=date]').fill('2026-11-17');
  assert.equal(await dialog.locator('[name=start]').inputValue(), '2026-11-05');
  assert.equal(await dialog.locator('[name=end]').inputValue(), '2026-11-13');
  await dialog.getByText('关联来源记录', { exact: true }).click();
  await dialog.locator(`[name=source][value="${manual.id}"]`).check();
  await dialog.getByRole('button', { name: '创建并编辑' }).click();
  await page.locator('#visual-editor h1').filter({ hasText: '阈值阶段回顾' }).waitFor();
  await idle();
  const summary = command('list', ['--from', '2026-11-17', '--type', 'stage-summary']).records[0].record;
  assert.deepEqual(summary.coverage, { start: '2026-11-05', end: '2026-11-13' });
  assert.deepEqual(summary.sources, [manual.id]);
  assert.ok(command('read', [summary.id]).body.includes(`(r-${manual.id}.md)`));
  await showProject();
  await page.locator('.research-timeline-summary').filter({ hasText: '阈值阶段回顾' }).waitFor();
  await page.locator(`[data-research-edit="${summary.id}"]`).click();
  await dialog.locator('[name=end]').fill('2026-11-12');
  await dialog.getByRole('button', { name: '保存属性' }).click();
  await page.locator('.research-entry-meta').getByText('覆盖 2026-11-05 – 2026-11-12').waitFor();
  assert.equal(command('read', [summary.id]).record.coverage.end, '2026-11-12');
  console.log('PASS distinct summary dates, source links and timeline coverage');

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
  assert.match(command('read', ['agent-review']).body, /r-agent-verification.md/);
  await page.getByRole('button', { name: '复测结果', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '复测结果', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.locator('[data-research-clear]').click();
  await page.locator('.research-entry-title [data-research-record=agent-verification]').waitFor();
  assert.equal(await page.locator('.research-entry').count(), 2);
  assert.match(await page.locator('.research-entry-meta').first().innerText(), /渲染构建 render-9c217/);
  await page.getByRole('button', { name: '新建研究记录' }).click();
  assert.equal(await dialog.locator('[name=field-build]').getAttribute('required'), '');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  console.log('PASS CLI rule discovery, batch validation and retry, project fields, templates and views refreshed in Meki');

  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.locator('.research-timeline-summary').filter({ hasText: 'Agent 复测总结' }).waitFor();
  await page.screenshot({ path: path.join(folder, 'timeline.png'), animations: 'disabled' });
  await page.locator('.research-entry-title [data-research-record=agent-verification]').click();
  await page.locator('#visual-editor h1').filter({ hasText: 'Agent 批次复测' }).waitFor();
  await idle();
  await sourceAppend('\n一份尚未保存的人工修改。');
  await page.locator('#dirty-dot').waitFor();
  const disk = command('read', [run.id]);
  command('batch', [], { records: [{ id: run.id, ifRevision: disk.revision, body: disk.body + '\nAgent 写入的新结果。\n' }] });
  await page.locator('#external-banner').waitFor();
  command('batch', [], { records: [{ id: run.id, ifRevision: disk.revision, body: 'Stale update' }] }, /changed/);
  await page.locator('[data-action=save]').click();
  await idle();
  assert.match(await page.locator('#source-editor .cm-content').innerText(), /尚未保存的人工修改/);
  assert.match(command('read', [run.id]).body, /Agent 写入的新结果/);
  assert.deepEqual(errors, []);
  console.log('PASS concurrent agent edits preserve disk changes and the unsaved Meki draft');
  console.log(`Timeline screenshot: ${path.join(folder, 'timeline.png')}`);
} finally {
  if (app) {
    await app.evaluate(({ app, BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.quit(); }).catch(() => {});
    await app.close().catch(() => {});
  }
}

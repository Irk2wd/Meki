import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { writeReportPdf, writeReportPptx } from './research-report-fixtures.mjs';

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

function commandAt(directory, name, args = [], input, errorPattern) {
  const result = spawnSync(process.execPath, [cli, name, directory, ...args, ...(input ? ['--input', '-'] : [])], {
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

const command = (name, args, input, errorPattern) => commandAt(project, name, args, input, errorPattern);
const tileTitle = '开启分块遮挡剔除能缩短 GPU 帧时间吗？';

let app, page;
const results = [], errors = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function showReaderReferences() {
  const toggle = page.locator('#research-reference-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function closeReader() {
  await idle();
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

async function editDescription() {
  const dialog = page.locator('#research-tools-dialog');
  await page.locator('.research-settings').getByRole('button', { name: '编辑项目描述', exact: true }).click();
  await dialog.getByRole('heading', { name: '编辑项目描述', exact: true }).waitFor();
  return dialog;
}

try {
  await launch();
  await page.getByRole('heading', { name: '科研项目', exact: true }).waitFor();
  await page.locator('#document-surface').waitFor({ state: 'hidden' });
  await page.locator('#workspace-switch').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '创建示例项目', exact: true }).click();
  await page.getByRole('heading', { name: '实时渲染性能研究', exact: true }).waitFor();
  await idle();
  const sidebarSettings = page.locator('#sidebar-settings-button');
  const settingsMenu = page.locator('#sidebar-settings-menu');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const opening = await sidebarSettings.evaluate(button => {
    button.click();
    return document.querySelector('#sidebar-settings-menu').getAnimations().map(animation => animation.transitionProperty);
  });
  assert.ok(opening.includes('opacity') && opening.includes('transform'));
  assert.equal(await sidebarSettings.getAttribute('aria-expanded'), 'true');
  assert.ok(await settingsMenu.getByRole('menuitem').first().evaluate(item => item === document.activeElement));
  await settingsMenu.evaluate(menu => Promise.allSettled(menu.getAnimations().map(animation => animation.finished)));
  const closingMenu = await settingsMenu.evaluate(menu => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { inert: menu.inert, properties: menu.getAnimations().map(animation => animation.transitionProperty) };
  });
  assert.ok(closingMenu.inert && closingMenu.properties.includes('opacity'));
  await settingsMenu.waitFor({ state: 'hidden' });
  assert.ok(await sidebarSettings.evaluate(button => button === document.activeElement));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await sidebarSettings.evaluate(button => {
    button.click();
    const count = document.querySelector('#sidebar-settings-menu').getAnimations().length;
    button.click();
    return count;
  }), 0);
  await settingsMenu.waitFor({ state: 'hidden' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  pass('the footer settings menu animates both ways, restores keyboard focus and respects reduced motion');

  assert.equal(await page.locator('[data-research-edit-description]').count(), 0);
  await page.locator('[data-research-destination=rules]').click();
  const settings = page.locator('.research-settings');
  const rulesSummary = settings.getByText('项目规则', { exact: true });
  const locationSummary = settings.getByText('项目位置', { exact: true });
  const copyPath = settings.getByRole('button', { name: '复制项目路径', includeHidden: true });
  assert.equal(await rulesSummary.evaluate(summary => summary.parentElement.open), false);
  assert.equal(await copyPath.isVisible(), false);
  await settings.screenshot({ path: path.join(folder, 'project-settings.png'), animations: 'disabled' });
  await locationSummary.click();
  await settings.getByText('.mekir/project.json', { exact: true }).waitFor();
  assert.equal(await copyPath.isVisible(), true);
  await locationSummary.click();
  assert.equal(await copyPath.isVisible(), false);
  const originalDescription = command('describe').project.description;
  const descriptionForm = await editDescription();
  const descriptionField = descriptionForm.getByLabel('项目描述', { exact: true });
  assert.equal(await descriptionField.inputValue(), originalDescription);
  await descriptionField.fill('不保存的临时描述');
  await descriptionForm.getByRole('button', { name: '取消', exact: true }).last().click();
  await descriptionForm.waitFor({ state: 'hidden' });
  assert.equal(command('describe').project.description, originalDescription);
  await rulesSummary.click();
  const experimentRules = settings.locator('[data-research-settings-section=type-experiment]');
  await experimentRules.click();
  await editDescription();
  const savedDescription = '研究遮挡剔除对 GPU 帧时间的影响。\n按机位对比 <原图> 和帧时间。';
  await descriptionField.fill(savedDescription);
  await descriptionForm.getByRole('button', { name: '保存', exact: true }).click();
  await descriptionForm.waitFor({ state: 'hidden' });
  assert.equal(await settings.locator('.research-settings-description p').textContent(), savedDescription);
  assert.equal(await rulesSummary.evaluate(summary => summary.parentElement.open), true);
  assert.equal(await experimentRules.evaluate(summary => summary.parentElement.open), true);
  assert.equal(command('describe').project.description, savedDescription);
  await page.locator('[data-research-destination=timeline]').click();
  assert.equal(await page.locator('.research-overview p').textContent(), savedDescription);
  await app.close();
  app = undefined;
  await launch();
  await page.getByRole('heading', { name: '实时渲染性能研究', exact: true }).waitFor();
  assert.equal(await page.locator('.research-overview p').textContent(), savedDescription);
  pass('project settings folds rules and paths, and description edits survive refresh, cancellation and restart');
  await page.locator('[data-research-destination=timeline][aria-current=page]').waitFor();
  await page.locator('[data-action="research-projects"]').first().click();
  const projectPicker = page.locator('#research-project-picker');
  await projectPicker.getByRole('button', { name: /实时渲染性能研究/ }).waitFor();
  await projectPicker.getByRole('button', { name: '创建示例项目', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await projectPicker.waitFor({ state: 'hidden' });
  pass('fresh and resumed windows start in the project shell, with project-only switching');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const rail = page.locator('#research-sidebar');
  await rail.getByRole('button', { name: '实验记录', exact: true }).click();
  await rail.locator('[data-research-destination=entries][aria-current=page]').waitFor();
  await rail.getByRole('button', { name: '时间线', exact: true }).press('Enter');
  await rail.locator('[data-research-destination=timeline][aria-current=page]').waitFor();
  await page.waitForFunction(() => document.querySelector('#app-sidebar:not([data-folding])')?.offsetWidth === 48);
  await rail.getByRole('button', { name: '实验记录', exact: true }).hover();
  assert.equal(await rail.getByRole('button', { name: '时间线', exact: true }).evaluate(el => getComputedStyle(el, '::before').content), 'none');
  assert.equal(await rail.getByRole('button', { name: '实验记录', exact: true }).evaluate(el => getComputedStyle(el, '::before').content), '"实验记录"');
  await page.screenshot({ path: path.join(folder, 'sidebar-rail.png') });
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  pass('the icon rail switches research pages with the mouse and keyboard without expanding');
  assert.equal(command('describe').format.manifest, '.mekir/project.json');
  assert.equal(command('describe').format.rules.instructions, 'project.instructions');
  const agentGuide = await fs.readFile(path.join(project, 'AGENTS.md'), 'utf8');
  assert.match(agentGuide, /读取当前项目[\s\S]*ifProjectRevision[\s\S]*修改字段、模板和视图/);
  assert.equal(command('read', ['exploration-review']).relativePath, '.mekir/summaries/r-exploration-review.md');
  assert.equal(command('read', ['tile-culling']).relativePath, 'records/r-tile-culling.md');
  assert.ok((await page.evaluate(() => window.meki.refreshWorkspace())).tree.every(entry => !entry.relativePath.startsWith('.mekir')));
  const phases = page.locator('.research-timeline-row');
  const optionsToggle = page.locator('[data-research-timeline-options]');
  async function openTimelineOptions() {
    if (!await page.locator('.research-timeline-options').evaluate(details => details.open)) await optionsToggle.click();
  }
  const phaseOrder = () => phases.locator('[data-research-phase]').evaluateAll(rows => rows.map(row => row.dataset.researchPhase));
  const legend = page.locator('.research-legend');
  const markerLegend = legend.getByRole('group', { name: '时间线标记', exact: true });
  const eventLegend = legend.getByRole('group', { name: '自定义事件', exact: true });
  const refresh = page.getByRole('button', { name: '刷新项目', exact: true });
  await page.clock.setFixedTime(new Date('2026-11-17T12:00:00+08:00'));
  await refresh.click();
  await idle();
  assert.deepEqual(await phaseOrder(), ['validation', 'exploration', 'baseline']);
  assert.match(await phases.first().innerText(), /进行中/);
  assert.equal(await phases.first().locator('.research-timeline-dot:not(.is-ended)').count(), 1);
  assert.equal(await phases.last().locator('.research-timeline-dot.is-ended').count(), 1);
  const tileReport = command('read', ['tile-culling']);
  const dayButton = day => page.locator(`[data-research-trial-day="exploration/2026-11-${day}"]`);
  const openFromDay = async (day, choose = false) => {
    await dayButton(day).focus();
    await dayButton(day).press('Enter');
    if (choose) await page.getByRole('dialog', { name: '2026-11-11 的实验记录' }).getByRole('button', { name: tileTitle }).click();
    await page.locator('#research-reader-title').getByText(tileTitle, { exact: true }).waitFor();
    await closeReader();
    assert.ok(await dayButton(day).evaluate(el => el === document.activeElement));
  };
  await openFromDay('07');
  await dayButton('08').click();
  await page.locator('#research-reader-title').getByText(tileTitle, { exact: true }).waitFor();
  await closeReader();
  assert.ok(await dayButton('08').evaluate(el => el === document.activeElement));
  const rerun = tileReport.body.replace('\n\n## 待验证', '\n| retry | 2026-11-11 | 复测 | 10.2 |\n\n## 待验证');
  command('batch', [], { records: [{ id: 'tile-culling', ifRevision: tileReport.revision, body: rerun }] });
  await refresh.click();
  await dayButton('11').and(page.getByRole('button', { name: '2026-11-11 的 2 条实验记录' })).waitFor();
  await openFromDay('11', true);
  assert.equal(await page.locator('[data-research-phase=exploration]').getAttribute('aria-pressed'), 'false');
  command('batch', [], { records: [{ id: 'tile-culling', ifRevision: command('read', ['tile-culling']).revision, body: tileReport.body }] });
  pass('dated trials open one report from multiple days and shared days offer a choice, with focus returned to the original date');
  await page.clock.setFixedTime(new Date('2026-11-19T12:00:00+08:00'));
  await refresh.click();
  await idle();
  assert.deepEqual(await phaseOrder(), ['validation', 'exploration', 'baseline']);
  assert.match(await phases.filter({ hasText: '方案探索' }).innerText(), /最近进展 11\/16/);
  const explorationFinding = '在城市街区的同一条轨迹上，采用保守阈值后，GPU 帧时间低于无剔除基线，遮挡边缘也未见闪烁。';
  assert.equal(await phases.filter({ hasText: '方案探索' }).locator('.research-phase-progress').textContent(), explorationFinding);
  const eventTypes = page.locator('.research-timeline-footer [data-research-event-types]');
  assert.ok(await eventTypes.isHidden());
  await optionsToggle.focus();
  await optionsToggle.press('Enter');
  assert.ok(await eventTypes.isVisible());
  await optionsToggle.press('Enter');
  assert.equal(await page.locator('.research-chart-guides .research-today-line').count(), 1);
  const retrospective = command('read', ['exploration-review']);
  const concurrentRun = command('read', ['tile-culling']);
  command('batch', [], { records: [retrospective, concurrentRun].map(({ record, revision }) =>
    ({ id: record.id, ifRevision: revision, date: '2026-11-19' })) });
  await refresh.click();
  await phases.filter({ hasText: '方案探索' }).getByText('最近进展 11/19').waitFor();
  assert.equal(await phases.filter({ hasText: '方案探索' }).locator('.research-phase-progress').textContent(), explorationFinding);
  assert.deepEqual(await phaseOrder(), ['validation', 'exploration', 'baseline']);
  command('batch', [], { records: [
    { id: 'exploration-review', ifRevision: command('read', ['exploration-review']).revision, body: '## 待验证\n\n更换机位后复测。' },
    { id: 'tile-culling', ifRevision: command('read', ['tile-culling']).revision, date: '2026-11-18' },
  ] });
  await refresh.click();
  await idle();
  const exploring = phases.locator('[data-research-phase=exploration]');
  const tileFinding = '在城市街区的同一条相机轨迹上，开启分块遮挡剔除后，GPU 帧时间缩短了。';
  await exploring.getByText(tileFinding, { exact: true }).waitFor();
  assert.match(await exploring.innerText(), /最近进展 11\/19/);
  await exploring.click();
  await page.locator('.research-progress-latest').getByText(tileFinding, { exact: true }).waitFor();
  await page.locator('.research-phase-summaries [data-research-record=exploration-review]').waitFor();
  await exploring.click();
  command('batch', [], { records: [retrospective, concurrentRun].map(({ record, body }) =>
    ({ id: record.id, ifRevision: command('read', [record.id]).revision, date: record.date, body })) });
  await refresh.click();
  await phases.filter({ hasText: '方案探索' }).getByText('最近进展 11/16').waitFor();
  assert.equal(await page.locator('.research-timeline [data-research-record]').count(), 0);
  pass('phase order keeps active phases first and sorts ended phases by end date despite later summaries');

  await phases.evaluateAll(rows => {
    for (const row of rows) row.addEventListener('transitionrun', event => {
      if (event.target === row && event.propertyName === 'background-color') {
        row.dataset.hoverTransition = row.matches(':hover') ? 'enter' : 'leave';
      }
    });
  });
  const firstPhase = phases.nth(0), nextPhase = phases.nth(1);
  await firstPhase.locator('.research-timeline-label').hover();
  await page.locator('.research-timeline-row[data-hover-transition="enter"]').first().waitFor();
  await firstPhase.evaluate(row => Promise.allSettled(row.getAnimations().map(animation => animation.finished)));
  const firstPhaseBounds = await firstPhase.boundingBox();
  await nextPhase.locator('.research-timeline-label').hover();
  await page.waitForFunction(() => {
    const [first, second] = document.querySelectorAll('.research-timeline-row');
    return first.dataset.hoverTransition === 'leave' && second.dataset.hoverTransition === 'enter';
  });
  assert.deepEqual(await firstPhase.boundingBox(), firstPhaseBounds);
  await nextPhase.evaluate(row => Promise.allSettled(row.getAnimations().map(animation => animation.finished)));
  await page.locator('.research-overview h1').hover();
  await page.waitForFunction(() => document.querySelectorAll('.research-timeline-row')[1].dataset.hoverTransition === 'leave');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await firstPhase.locator('.research-timeline-label').hover();
  assert.equal(await firstPhase.evaluate(row => getComputedStyle(row).transitionDuration), '0s');
  await page.locator('.research-overview h1').hover();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  pass('moving between phase rows fades the old and new highlights without moving the rows and respects reduced motion');

  const rangeButton = page.locator('[data-research-range]');
  assert.equal(await page.locator('.research-entry').count(), 0);
  const quickRange = (name) => page.getByRole('group', { name: '快捷时间范围' }).getByRole('button', { name, exact: true });
  for (const [name, start] of [['最近 7 天', '2026-11-13'], ['最近 14 天', '2026-11-06'],
    ['最近 1 个月', '2026-11-01'], ['最近 3 个月', '2026-11-01']]) {
    const preset = quickRange(name);
    await preset.click();
    assert.equal(await preset.getAttribute('aria-pressed'), 'true');
    assert.equal(await rangeButton.getAttribute('data-start'), start);
    assert.equal(await rangeButton.getAttribute('data-end'), '2026-11-19');
  }
  await page.clock.setFixedTime(new Date('2024-03-31T12:00:00+08:00'));
  await quickRange('最近 1 个月').click();
  assert.equal(await rangeButton.getAttribute('data-start'), '2024-03-31');
  assert.equal(await rangeButton.getAttribute('data-end'), '2024-03-31');
  assert.equal(await page.locator('[data-research-overview][data-single-day] [role="slider"][aria-disabled="true"]').count(), 3);
  await page.clock.setFixedTime(new Date('2026-11-19T12:00:00+08:00'));
  await refresh.click();
  await idle();
  assert.equal(await quickRange('最近 1 个月').getAttribute('aria-pressed'), 'true');
  assert.equal(await rangeButton.getAttribute('data-start'), '2026-11-01');
  await quickRange('最近 7 天').click();
  assert.equal(await page.locator('.research-entry').count(), 0);
  await page.locator('[data-research-phase=validation]').click();
  assert.equal(await page.locator('.research-entry').count(), 1);
  const focus = page.locator('.research-phase-focus');
  assert.match(await focus.innerText(), /本阶段要判断什么[\s\S]*同轨迹/);
  const stageDetail = page.getByRole('region', { name: '复测与验证', exact: true });
  assert.equal(await stageDetail.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
  const progressSection = stageDetail.getByRole('region', { name: '最新进展', exact: true });
  const evidenceSection = stageDetail.getByRole('region', { name: '结论依据', exact: true });
  const experimentSection = stageDetail.getByRole('region', { name: /^实验记录/ });
  assert.equal(await focus.evaluate(el => el.closest('header').nextElementSibling.matches('.research-progress')), true);
  assert.equal(await evidenceSection.evaluate(el => el.previousElementSibling.matches('.research-progress')), true);
  await evidenceSection.getByRole('heading', { name: '结论依据' }).waitFor();
  assert.equal(await progressSection.locator('.research-sample-table').count(), 0);
  for (const section of [progressSection, evidenceSection, experimentSection]) {
    assert.equal(await section.evaluate(el => getComputedStyle(el).borderTopWidth), '1px');
  }
  const recentExperiment = page.locator('.research-progress-latest [data-research-progress-link=forest-validation]');
  assert.equal(await page.locator('.research-entry-conclusion').textContent(), '开启遮挡剔除后，树林轨迹的 GPU 帧时间中位数为 11.4 ms。');
  assert.equal(await recentExperiment.locator('.research-progress-conclusion').textContent(),
    await page.locator('.research-entry-conclusion').textContent());
  const timingSample = page.locator('.research-sample-table[data-research-sample="forest-timings"]');
  await timingSample.scrollIntoViewIfNeeded();
  await timingSample.getByRole('columnheader', { name: 'cpu_render_and_png_ms' }).waitFor();
  assert.equal(await timingSample.locator('tbody tr').count(), 4);
  assert.ok((await timingSample.locator('tbody').innerText()).includes('171.12'));
  await page.locator('.research-proof-open[data-research-progress-link="forest-timings"]').click();
  await page.locator('#research-tools-dialog .research-table-scroll table').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.research-entry [data-research-record=forest-validation]').click();
  await page.locator('#visual-editor').getByRole('heading', { name: '待验证', exact: true }).waitFor();
  assert.equal(await page.locator('#visual-editor h2').last().textContent(), '待验证');
  const sampleLinks = page.locator('#research-reader-related');
  assert.equal(await sampleLinks.isVisible(), false);
  await showReaderReferences();
  await sampleLinks.locator('[data-research-related=forest-timings]').click();
  const sampleTable = page.getByRole('table', { name: '逐视角 CPU 计时表 · CSV' });
  await sampleTable.getByRole('cell', { name: '487.47', exact: true }).waitFor();
  assert.equal(await sampleTable.locator('tbody tr').count(), 8);
  await page.getByRole('button', { name: '关闭证据预览', exact: true }).click();
  for (const [id, count] of [['forest-observations', 2], ['forest-slides', 3]]) {
    const link = sampleLinks.locator(`[data-research-related="${id}"]`);
    await link.click();
    const preview = page.locator('#research-report-dialog');
    for (let number = 1; number <= count; number++) {
      if (number > 1) await preview.locator('[data-report-next]').click();
      await preview.getByText(`第 ${number} 页，共 ${count} 页`, { exact: true }).waitFor();
      await preview.locator('.research-report-stage[aria-busy="false"] #research-report-status[hidden]').waitFor({ state: 'attached' });
    }
    await preview.getByRole('button', { name: '关闭汇报预览' }).click();
    await link.and(page.locator(':focus')).waitFor();
  }
  await closeReader();
  pass('the built-in forest record opens its CSV, two-page PDF and three-slide PowerPoint and returns to the attachment');
  await page.locator('[data-research-phase=validation]').click();
  await page.locator('[data-research-reset-range]').click();
  pass('date presets use inclusive days and respect the project start and time zone');

  const rangePicker = page.getByRole('dialog', { name: '选择时间范围' });
  const applyRange = rangePicker.getByRole('button', { name: '应用' });
  await rangeButton.click();
  await rangePicker.getByLabel('开始日期').fill('2026-11-10');
  await rangePicker.getByLabel('结束日期').fill('2026-11-08');
  await applyRange.click();
  await rangePicker.getByRole('alert').filter({ hasText: '结束日期不能早于开始日期。' }).waitFor();
  await rangePicker.getByLabel('结束日期').fill('2026-11-14');
  await applyRange.click();
  assert.deepEqual(await phaseOrder(), ['validation', 'exploration', 'baseline']);
  const outsidePhase = phases.filter({ hasText: '基线测量' });
  assert.equal(await outsidePhase.locator('.research-timeline-bar, .research-timeline-dot').count(), 0);
  assert.equal(await page.locator('.research-entry').count(), 0);
  assert.equal(await page.locator('[data-research-record=tile-culling]').count(), 0);
  assert.equal(await phases.filter({ hasText: '方案探索' }).locator('.research-timeline-bar').evaluate(bar => bar.style.getPropertyValue('--left')), '0%');
  await page.locator('[data-research-reset-range]').click();

  const ruler = page.locator('[data-research-axis]');
  const zoom = page.getByRole('button', { name: '放大时间轴', exact: true });
  await zoom.click();
  async function pan(from, to) {
    await idle();
    await ruler.hover();
    const bounds = await ruler.boundingBox();
    const x = fraction => bounds.x + bounds.width * fraction;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x(from), y);
    await page.mouse.down();
    await page.mouse.move(x(to), y, { steps: 4 });
    await page.mouse.up();
  }
  await pan(.9, .1);
  assert.match(await rangeButton.innerText(), /2026-11-08 – 2026-11-19/);
  assert.ok(await page.getByRole('button', { name: '向后移动时间轴' }).isDisabled());
  await pan(.1, .9);
  assert.match(await rangeButton.innerText(), /2026-11-01 – 2026-11-12/);
  assert.ok(await page.getByRole('button', { name: '向前移动时间轴' }).isDisabled());
  await rangeButton.click();
  await rangePicker.getByLabel('开始日期').fill('2026-11-05');
  await rangePicker.getByLabel('结束日期').fill('2026-11-14');
  await applyRange.click();
  assert.match(await rangeButton.innerText(), /2026-11-05 – 2026-11-14/);
  assert.equal(await page.locator('.research-entry').count(), 0);

  const overviewRail = page.locator('[data-research-overview]');
  const overviewHandle = part => overviewRail.locator(`[data-research-overview-handle="${part}"]`);
  async function dragOverview(from, to, { relative = false, live } = {}) {
    await overviewRail.scrollIntoViewIfNeeded();
    const box = await overviewRail.boundingBox(), dayWidth = box.width / 19;
    const handle = typeof from === 'string' ? await overviewHandle(from).boundingBox() : null;
    const x = handle ? handle.x + handle.width / 2 : box.x + from * dayWidth;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move((relative ? x : box.x) + to * dayWidth, y, { steps: 4 });
    if (live) await page.locator(`[data-research-range][data-start="${live[0]}"][data-end="${live[1]}"]`).waitFor();
    await page.mouse.up();
  }
  async function assertRange(start, end) {
    assert.equal(await rangeButton.getAttribute('data-start'), start);
    assert.equal(await rangeButton.getAttribute('data-end'), end);
  }
  await page.locator('[data-research-reset-range]').click();
  await dragOverview(4.5, 13.5, { live: ['2026-11-05', '2026-11-14'] });
  await assertRange('2026-11-05', '2026-11-14');
  await dragOverview('start', 3, { relative: true });
  await assertRange('2026-11-08', '2026-11-14');
  await dragOverview('end', -2, { relative: true });
  await assertRange('2026-11-08', '2026-11-12');
  const endHandle = overviewHandle('end');
  await endHandle.press('ArrowLeft');
  await assertRange('2026-11-08', '2026-11-11');
  assert.ok(await endHandle.evaluate(handle => document.activeElement === handle));

  const move = await overviewHandle('move').boundingBox();
  const moveX = move.x + move.width / 2, moveY = move.y + move.height / 2;
  const dayWidth = (await overviewRail.boundingBox()).width / 19;
  await page.mouse.move(moveX, moveY);
  await page.mouse.down();
  await page.mouse.move(moveX + dayWidth / 4, moveY);
  await page.waitForFunction(() => document.querySelector('[data-research-overview]').style.getPropertyValue('--drag-left'));
  assert.equal(await overviewRail.getAttribute('data-drag-part'), 'move');
  assert.equal(await overviewRail.locator('[data-tip="move"]').textContent(), '2026-11-08 – 2026-11-11');
  assert.ok((await overviewHandle('move').boundingBox()).x > move.x);
  await assertRange('2026-11-08', '2026-11-11');
  await page.mouse.up();
  assert.equal((await overviewHandle('move').boundingBox()).x, move.x);

  await dragOverview('move', 18.9);
  await assertRange('2026-11-16', '2026-11-19');
  await dragOverview('move', 0.1);
  await assertRange('2026-11-01', '2026-11-04');
  await dragOverview('start', 10, { relative: true });
  await assertRange('2026-11-04', '2026-11-04');
  await dragOverview(13.5, 4.5);
  await assertRange('2026-11-05', '2026-11-14');
  assert.deepEqual(await phaseOrder(), ['validation', 'exploration', 'baseline']);
  assert.equal(await page.locator('.research-entry').count(), 0);
  pass('the overview brushes new ranges, resizes either edge, and moves a fixed interval within the project dates');
  pass('custom ranges and bounded pan and zoom clip coverage without opening an experiment list');

  async function openAppearance() {
    await page.locator('#sidebar-settings-button').click();
    await page.locator('#sidebar-settings-menu').getByRole('menuitem', { name: '外观与排版' }).click();
  }
  async function selectTheme(id) {
    await openAppearance();
    await page.locator(`#theme-choices button[data-theme="${id}"]`).click();
    await page.locator('.research-toolbar').evaluate(toolbar => toolbar.click());
  }
  await selectTheme('graph');
  const overview = await page.locator('.research-overview').evaluate(header => {
    const copy = header.firstElementChild;
    return {
      background: getComputedStyle(copy).backgroundColor,
      textOnBacking: Boolean(copy.querySelector('h1') && copy.querySelector('p') && copy.querySelector('.research-overview-stats')),
      blankToRight: copy.getBoundingClientRect().right < header.getBoundingClientRect().right,
    };
  });
  assert.deepEqual(overview, {
    background: await page.locator('.research-timeline').evaluate(timeline => getComputedStyle(timeline).backgroundColor),
    textOnBacking: true,
    blankToRight: true,
  });
  assert.match(await page.locator('.research-content').evaluate(content => getComputedStyle(content).backgroundImage), /linear-gradient/);
  pass('the project title, description and counts sit on a solid backing with grid in the surrounding blank space');
  await selectTheme('cyber');
  assert.match(await page.locator('.research-content').evaluate(content => getComputedStyle(content).backgroundImage), /linear-gradient/);
  await page.screenshot({ path: path.join(folder, 'theme-timeline.png') });

  const tile = command('read', ['tile-culling']);
  const filler = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 次记录依次检查相机轨迹、可见性与帧时间。`).join('\n\n');
  command('batch', [], { records: [{ id: tile.record.id, ifRevision: tile.revision, body: tile.body.replace('[城市街区基线]', `${filler}\n\n[城市街区基线]`) }] });
  await refresh.click();
  await idle();
  await page.locator('[data-research-phase="exploration"]').click();
  assert.equal(await page.locator('.research-entry').count(), 2);
  const phaseSummary = page.locator('.research-phase-summaries [data-research-record=exploration-review]');
  const experimentRow = page.locator('.research-entry').filter({ has: page.locator('.research-entry-title [data-research-record=tile-culling]') });
  const tilePreview = command('list', ['--phase', 'exploration']).records.find(item => item.record.id === 'tile-culling');
  assert.equal(await experimentRow.locator('.research-entry-conclusion').textContent(), tilePreview.excerpt);
  await phaseSummary.locator('.research-progress-conclusion').getByText(explorationFinding).waitFor();
  const experimentMark = experimentRow.locator('.research-entry-type .research-kind-mark');
  const summaryMark = phaseSummary.locator('.research-kind-mark');
  assert.equal(await experimentMark.getAttribute('data-record-kind'), 'entry');
  assert.equal(await summaryMark.getAttribute('data-record-kind'), 'summary');
  assert.notEqual(await experimentMark.evaluate(el => getComputedStyle(el).color), await summaryMark.evaluate(el => getComputedStyle(el).color));
  const progressSource = page.locator('[data-research-progress-link=tile-culling]');
  await progressSource.click();
  await page.locator('#research-reader-title').getByText(tileTitle).waitFor();
  assert.equal(await page.locator('#research-reader-mark svg').innerHTML(), await experimentMark.locator('svg').innerHTML());
  await closeReader();
  await progressSource.and(page.locator(':focus')).waitFor();
  assert.deepEqual(await phaseSummary.locator('.research-summary-dates > span').allTextContents(), ['覆盖 2026-11-05 – 2026-11-13', '撰写于 2026-11-16']);
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
  const summaryTable = page.locator('#visual-editor table');
  await summaryTable.getByRole('columnheader', { name: 'GPU 帧时间中位数（ms）' }).waitFor();
  await summaryTable.getByRole('row').filter({ hasText: '保守深度阈值' }).getByRole('cell', { name: '10.7', exact: true }).waitFor();
  assert.match(await page.locator('#document-scroll').evaluate(content => getComputedStyle(content).backgroundImage), /linear-gradient/);
  assert.match(await page.locator('#visual-editor h1').first().evaluate(heading => getComputedStyle(heading).fontFamily), /monospace/);
  await page.locator('#visual-editor a[href="mekir:tile-culling"]').click();
  await page.locator('#research-reader-title').getByText(tileTitle, { exact: true }).waitFor();
  await idle();
  const baselineLink = page.locator('#visual-editor a[href="mekir:baseline-city"]');
  await baselineLink.scrollIntoViewIfNeeded();
  const documentScroll = page.locator('#document-scroll');
  const tileScroll = await documentScroll.evaluate(element => element.scrollTop);
  assert.ok(tileScroll > 0);
  await baselineLink.click();
  const readerTitle = page.locator('#research-reader-title');
  await readerTitle.getByText('城市街区基线', { exact: true }).waitFor();
  await idle();
  const back = page.getByRole('button', { name: '返回上一份文档' });
  await back.click();
  await readerTitle.getByText(tileTitle, { exact: true }).waitFor();
  assert.equal(await documentScroll.evaluate(element => element.scrollTop), tileScroll);
  assert.ok(await baselineLink.evaluate(link => link === document.activeElement));
  await idle();
  await back.click();
  await readerTitle.getByText('方案探索阶段总结', { exact: true }).waitFor();
  await idle();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const closingReader = await page.getByRole('button', { name: '返回研究列表' }).evaluate(button => {
    button.click();
    const surfaces = [document.querySelector('#document-surface'), document.querySelector('.research-reader-scrim')].filter(surface => surface.getClientRects().length);
    return { open: surfaces[0].parentElement.classList.contains('research-reader-open'),
      fading: surfaces.every(surface => surface.getAnimations().some(animation => Number(animation.effect.getKeyframes().at(-1).opacity) === 0)) };
  });
  assert.deepEqual(closingReader, { open: true, fading: true });
  await page.locator('#document-surface').waitFor({ state: 'hidden' });
  assert.equal(await researchScroll.evaluate(element => element.scrollTop), scroll);
  assert.equal(await page.locator('#research-date').inputValue(), '2026-11-07');
  assert.match(await rangeButton.innerText(), /2026-11-05 – 2026-11-14/);
  assert.equal(await page.locator('[data-research-phase="exploration"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await phaseSummary.evaluate(button => document.activeElement === button), true);
  pass('linked previews animate back to the timeline and restore scroll, focus and filters');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820));
  await selectTheme('paper');
  pass('the timeline and record reader share the selected theme');
  await page.locator('[data-research-reset-range]').click();

  await page.locator('#research-date').fill('');
  const peer = page.locator('.research-entry-title [data-research-record="tile-culling"]');
  const other = page.locator('.research-entry-title [data-research-record="conservative-depth"]');
  await peer.click();
  await page.locator('.research-peek-split').waitFor();
  assert.equal(await page.locator('#research-workspace').evaluate(panel => panel.inert), false);
  await page.waitForFunction(() => {
    const list = document.querySelector('#research-workspace').getBoundingClientRect();
    const reader = document.querySelector('#document-surface').getBoundingClientRect();
    return Math.abs(list.right - reader.left) < 2 && Math.abs(list.top - reader.top) < 2;
  });
  await other.click();
  await readerTitle.getByText('验证保守深度阈值').waitFor();
  assert.equal(await other.getAttribute('aria-current'), 'true');
  await other.evaluate(last => {
    document.querySelector('.research-entry-title [data-research-record="tile-culling"]').click();
    last.click();
  });
  await page.waitForFunction(() => !document.body.classList.contains('is-busy') && document.querySelector('#research-reader-title').textContent === '验证保守深度阈值');
  await page.locator('[data-peek-step="-1"]').click();
  await readerTitle.getByText(tileTitle).waitFor();
  await closeReader();
  assert.ok(await peer.evaluate(button => button === document.activeElement));
  pass('records switch inside one open desktop reader and return to the selected list item');

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
  experiment.fields.find(field => field.id === 'gpu_ms').description = '固定机位，并保存原始逐帧计时表。';
  experiment.fields.push({ id: 'build', label: '渲染构建', type: 'text', required: true, description: '渲染器 commit 或制品 ID。' });
  const outcome = experiment.fields.find(field => field.id === 'outcome');
  outcome.options = ['有效', '待复核', '无效'];
  outcome.default = '待复核';
  experiment.template += '\n## 渲染构建\n\n{{field.build}}\n';
  config.views.push({ id: 'verification', label: '复测结果', layout: 'journal', order: 'newest', typeIds: ['experiment'], phaseIds: ['validation'], fieldIds: ['build', 'gpu_ms'] });
  config.defaultView = 'verification';
  config.phases.find(phase => phase.id === 'validation').end = '2026-11-19';
  command('configure', [], { ifRevision: discovery.revision, project: config });
  const updated = command('describe');
  assert.notEqual(updated.revision, discovery.revision);
  const verificationView = page.getByRole('button', { name: '复测结果', exact: true });
  await verificationView.waitFor();
  await page.locator('[data-research-destination=rules]').click();
  await page.locator('.research-rules > summary').click();
  await page.locator('.research-rules summary').filter({ hasText: 'experiment' }).click();
  await page.locator('.research-rules').getByText(/最小值 0/).waitFor();
  await page.locator('.research-rules').getByText(/新记录默认值 待复核/).waitFor();
  await verificationView.click();
  const metric = page.locator('[data-field-record=forest-validation][data-research-field=gpu_ms]');
  await metric.click();
  const historicalRules = page.locator('#research-tools-dialog [data-rule-id=gpu_ms][open]');
  await historicalRules.getByText(/去掉预热帧后的 GPU 帧时间中位数/).waitFor();
  await historicalRules.getByText(/固定机位，并保存原始逐帧计时表/).waitFor();
  await page.keyboard.press('Escape');
  await metric.and(page.locator(':focus')).waitFor();
  await page.locator('[data-research-edit=forest-validation]').click();
  assert.equal(await dialog.locator('[name=field-build]').inputValue(), '');
  assert.equal(await dialog.locator('[name=field-outcome] option:checked').innerText(), '历史值 需复测');
  await dialog.locator('[name=field-gpu_ms]').fill('11.5');
  await dialog.getByRole('button', { name: '保存属性' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const historical = command('read', ['forest-validation']).record.fields;
  assert.equal(historical.gpu_ms, 11.5);
  assert.equal(command('read', ['forest-validation']).fieldOrigins.gpu_ms.rule.description, '固定机位，并保存原始逐帧计时表。');
  assert.equal(historical.outcome, '需复测');
  assert.equal(Object.hasOwn(historical, 'build'), false);
  await page.locator('.research-entry-title [data-research-record=forest-validation]').click();
  await page.locator('[data-action=research-edit-body]').click();
  await page.locator('[data-mode=source]').click();
  const previousTiming = command('read', ['forest-validation']);
  const timingMarkdown = await fs.readFile(path.join(project, previousTiming.relativePath), 'utf8');
  await page.locator('#source-editor .cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(timingMarkdown.replace('"gpu_ms": 11.5', '"gpu_ms": 11.6'));
  await page.locator('[data-action=save]').click();
  await idle();
  const savedTiming = command('read', ['forest-validation']);
  assert.equal(savedTiming.record.fields.gpu_ms, 11.6);
  assert.notEqual(savedTiming.record.fieldRules, previousTiming.record.fieldRules);
  assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  await page.locator('[data-action=research-edit-body]').click();
  await page.locator('#research-field-toggle').click();
  const readerRule = page.locator('#research-tools-dialog [data-rule-id=gpu_ms]');
  await readerRule.locator('> summary').click();
  await readerRule.getByText('11.6 ms', { exact: true }).waitFor();
  await readerRule.getByText('与记录采用的口径一致。').waitFor();
  await page.keyboard.press('Escape');
  await closeReader();
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
  assert.equal(await verificationView.getAttribute('aria-pressed'), 'true');
  await page.locator('.research-entry-title [data-research-record=agent-verification]').waitFor();
  assert.equal(await page.locator('.research-entry').count(), 2);
  assert.match(await page.locator('.research-entry-meta').first().innerText(), /渲染构建 render-9c217/);
  await page.getByRole('button', { name: '新建研究记录' }).click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('[name=field-build]').getAttribute('required'), '');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  pass('project rules refresh fields, templates and views, while editing an older record preserves its historical values');

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
  const timingRows = ['round,gpu_ms,note', '001,10.9,"two, views\r\nwith ""canopy"""',
    ...Array.from({ length: 50 }, (_, i) => [i + 2, 11, i === 49 ? '=1+2' : ''].join(','))];
  await fs.writeFile(path.join(archiveRun, 'timings.csv'), '\uFEFF' + timingRows.join('\r\n') + '\r\n');
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
  assert.equal(await page.getByText('待补报告', { exact: true }).getAttribute('data-record-kind'), 'warning');
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
  const inspector = page.locator('#research-evidence-inspector');
  await showReaderReferences();
  await related.getByText('固定四视角并报告逐轮计时。').waitFor();
  await page.locator('#visual-editor a[href="mekir:forest-canopy"]').click();
  await inspector.getByRole('heading', { name: '树冠原图' }).waitFor();
  await inspector.locator('img').evaluate(async image => { await image.decode(); });
  await inspector.getByRole('button', { name: '返回正文' }).click();
  await related.getByRole('button', { name: '论文 v3' }).click();
  await inspector.locator('pre').getByText(/Four-view validation/).waitFor();
  await inspector.getByRole('button', { name: '返回正文' }).click();
  await related.getByRole('button', { name: '森林四视角报告' }).click();
  await page.locator('#research-reader-title').getByText('森林四视角报告').waitFor();
  await related.getByRole('button', { name: 'timings.csv', exact: true }).click();
  const timingTable = inspector.getByRole('table', { name: 'timings.csv' });
  await timingTable.getByRole('columnheader', { name: 'gpu_ms' }).waitFor();
  assert.deepEqual(await timingTable.locator('tbody tr').first().locator('td').allTextContents(), ['001', '10.9', 'two, views\nwith "canopy"']);
  assert.equal(await timingTable.locator('tbody tr').count(), 50);
  await inspector.getByRole('button', { name: '下一页', exact: true }).click();
  assert.deepEqual(await timingTable.getByRole('cell').allTextContents(), ['51', '11', '=1+2']);
  const pin = inspector.getByRole('button', { name: '固定到右栏' });
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  await pin.click();
  assert.ok(await pin.evaluate(button => button === document.activeElement));
  assert.equal(await pin.getAttribute('aria-pressed'), 'true');
  const manifestLink = related.getByRole('button', { name: 'run_manifest.json', exact: true });
  const imageLink = related.getByRole('button', { name: 'canopy.png', exact: true });
  await manifestLink.click();
  await imageLink.click();
  await inspector.locator('img').evaluate(async image => { await image.decode(); });
  assert.deepEqual(await inspector.getByRole('tab').allTextContents(), ['timings.csv', 'canopy.png']);
  await manifestLink.click();
  await inspector.getByRole('tab', { name: 'timings.csv', exact: true }).click();
  assert.deepEqual(await timingTable.getByRole('cell').allTextContents(), ['51', '11', '=1+2']);
  await inspector.getByRole('tab', { name: 'timings.csv' }).press('End');
  await inspector.locator('pre').getByText(/Electric Dreams/).waitFor();
  await inspector.getByRole('tab', { name: 'timings.csv' }).click();
  await pin.click();
  assert.deepEqual(await inspector.getByRole('tab').allTextContents(), ['timings.csv']);
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  await pin.click();
  await manifestLink.click();
  await inspector.getByRole('button', { name: '关闭 run_manifest.json' }).click();
  await inspector.getByLabel('首行作为列名').uncheck();
  await timingTable.getByRole('columnheader', { name: '列 1', exact: true }).waitFor();
  assert.deepEqual(await timingTable.locator('tbody tr').first().locator('td').allTextContents(), ['round', 'gpu_ms', 'note']);
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'hidden' });
  const reportScroll = await documentScroll.evaluate(element => element.scrollTop);
  await manifestLink.click();
  await inspector.locator('pre').getByText(/Electric Dreams/).waitFor();
  assert.equal(await inspector.evaluate(pane => getComputedStyle(pane).webkitAppRegion), 'no-drag');
  await inspector.evaluate(pane => Promise.allSettled(pane.getAnimations().map(animation => animation.finished)));
  const edges = await page.evaluate(() => [document.querySelector('#editor-workspace').getBoundingClientRect().right,
    document.querySelector('#research-evidence-inspector').getBoundingClientRect().left]);
  assert.ok(Math.abs(edges[0] - edges[1]) <= 2, `Report and evidence occupy adjacent columns: ${edges}`);
  await inspector.getByRole('button', { name: '关闭证据预览', exact: true }).click();
  await inspector.waitFor({ state: 'hidden' });
  assert.ok(await manifestLink.evaluate(link => link === document.activeElement));
  assert.equal(await documentScroll.evaluate(element => element.scrollTop), reportScroll);
  await page.locator('#research-reader-title').getByText('森林四视角报告', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回上一份文档' }).click();
  await page.locator('#research-reader-title').getByText('森林结果采用决定').waitFor();
  await page.screenshot({ path: path.join(folder, 'research-evidence.png'), animations: 'disabled' });
  pass('adoption decisions link back to comparable runs, manuscript versions and read-only images, CSV and manifests');

  await closeReader();
  assert.equal(await eventLegend.count(), 0);
  command('batch', [], { records: [{ id: 'baseline-meeting', type: 'group-meeting', title: '基线组会', date: '2026-11-06', phaseId: 'baseline' }] });
  const expanded = command('describe');
  expanded.project.phases.push(...Array.from({ length: 12 }, (_, i) => ({
    id: `extra-${i + 1}`, title: `补充阶段 ${i + 1}`, start: '2026-10-01', end: '2026-11-06',
  })));
  command('configure', [], { ifRevision: expanded.revision, project: expanded.project });
  await refresh.click();
  await idle();
  const timelineView = page.locator('[data-research-destination=timeline]');
  await timelineView.click();
  await legend.getByText('组会汇报', { exact: true }).waitFor();
  const pagedLegend = await legend.innerHTML();
  const pageSize = page.getByRole('spinbutton', { name: '每页阶段数' });
  await openTimelineOptions();
  const pageNumber = page.locator('#research-phase-page-number');
  const nextPage = page.getByRole('button', { name: '下一页', exact: true });
  const previousPage = page.getByRole('button', { name: '上一页', exact: true });
  assert.equal(await pageSize.inputValue(), '10');
  assert.equal(await phases.count(), 10);
  assert.equal(await previousPage.isDisabled(), true);
  assert.equal((await phaseOrder())[0], 'validation');
  await pageSize.fill('4');
  await pageSize.press('Enter');
  await pageNumber.getByText('第 1 页，共 4 页', { exact: true }).waitFor();
  const firstPage = await phaseOrder();
  assert.equal(firstPage.length, 4);
  assert.deepEqual(firstPage, ['validation', 'exploration', 'baseline', 'extra-1']);
  const timeSpan = [await rangeButton.getAttribute('data-start'), await rangeButton.getAttribute('data-end')];
  const journal = await page.locator('#research-journal-title').allTextContents();
  await nextPage.click();
  const secondPage = await phaseOrder();
  assert.equal(secondPage.length, 4);
  assert.ok(secondPage.every(id => !firstPage.includes(id)));
  assert.deepEqual([await rangeButton.getAttribute('data-start'), await rangeButton.getAttribute('data-end')], timeSpan);
  assert.deepEqual(await page.locator('#research-journal-title').allTextContents(), journal);
  await page.locator('[data-research-destination=entries]').click();
  await timelineView.click();
  assert.deepEqual(await phaseOrder(), secondPage);
  assert.equal(await pageNumber.innerText(), '第 2 页，共 4 页');
  await page.locator('.research-timeline').screenshot({ path: path.join(folder, 'timeline-pagination.png'), animations: 'disabled' });
  await previousPage.click();
  assert.deepEqual(await phaseOrder(), firstPage);
  for (let i = 0; i < 3; i++) await nextPage.click();
  assert.equal(await phases.count(), 3);
  assert.equal(await nextPage.isDisabled(), true);
  assert.equal(await page.locator('[data-research-timeline-events~="baseline-meeting"]').count(), 0);
  assert.equal(await legend.innerHTML(), pagedLegend);
  const lastPage = await phaseOrder();
  await quickRange('最近 7 天').click();
  assert.equal(await pageNumber.innerText(), '第 4 页，共 4 页');
  assert.deepEqual(await phaseOrder(), lastPage);
  assert.equal(await phases.locator('.research-timeline-bar').count(), 0);
  await pan(.1, .9);
  assert.equal(await pageNumber.innerText(), '第 4 页，共 4 页');
  assert.deepEqual(await phaseOrder(), lastPage);
  assert.equal(await legend.innerHTML(), pagedLegend);
  await page.locator('[data-research-reset-range]').click();
  assert.deepEqual(await phaseOrder(), lastPage);
  await openTimelineOptions();
  await page.getByRole('button', { name: '全部阶段', exact: true }).click();
  assert.equal(await phases.count(), 15);
  assert.equal(await pageNumber.count(), 0);
  pass('phase pagination preserves the sorted page and event legend across views and date ranges');

  async function showProjectPicker() {
    await page.locator('#research-sidebar [data-action=research-projects]').click();
    await projectPicker.waitFor({ state: 'visible' });
  }
  async function createPeer(title) {
    await showProjectPicker();
    await projectPicker.getByRole('button', { name: '创建示例项目', exact: true }).click();
    await idle();
    const state = await page.evaluate(() => window.meki.researchSnapshot());
    const configuration = commandAt(state.root, 'describe');
    configuration.project.title = title;
    commandAt(state.root, 'configure', [], { ifRevision: configuration.revision, project: configuration.project });
    await refresh.click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    return { root: state.root, id: state.project.id, title };
  }
  async function switchProject(root) {
    await showProjectPicker();
    await projectPicker.locator('[data-research-project]').evaluateAll((buttons, target) => {
      const button = buttons.find(button => button.dataset.researchProject === target);
      if (!button) throw new Error(`Project not found: ${target}`);
      button.click();
    }, root);
    await idle();
    assert.equal((await page.evaluate(() => window.meki.researchSnapshot())).root, root);
  }

  const ownerId = command('describe').project.id;
  const firstPeer = await createPeer('复现实验项目');
  const secondPeer = { root: path.join(folder, 'paper-analysis'), id: 'paper-analysis', title: '论文分析项目' };
  commandAt(secondPeer.root, 'init', [], {
    version: 1, id: secondPeer.id, title: secondPeer.title, timezone: 'Asia/Shanghai',
    phases: [{ id: 'drafting', title: '稿件修改', start: '2026-11-17' }],
    instructions: ['稿件版本使用 Git 提交号。'],
    recordTypes: [{ id: 'writing', label: '写作记录', kind: 'entry', description: '追踪稿件的章节修改。',
      fields: [{ id: 'chapter', label: '章节', type: 'text', required: true }, { id: 'draft', label: '稿件版本', type: 'text' }],
      template: '# {{title}}\n\n{{field.chapter}} · {{field.draft}}\n' }],
    views: [{ id: 'timeline', label: '时间线', layout: 'timeline', order: 'newest', fieldIds: ['chapter'] }], defaultView: 'timeline',
  });
  const paperRules = commandAt(secondPeer.root, 'describe');
  assert.deepEqual(paperRules.project.instructions, ['稿件版本使用 Git 提交号。']);
  commandAt(secondPeer.root, 'batch', [], { ifProjectRevision: paperRules.revision, records: [{
    id: 'methods', ifRevision: null, type: 'writing', title: '方法章节修改', date: '2026-11-18', phaseId: 'drafting',
    fields: { chapter: '方法', draft: 'commit-d17' },
  }] });
  assert.match(commandAt(secondPeer.root, 'read', ['methods']).body, /方法 · commit-d17/);
  await app.evaluate((_electron, target) => { process.env.MEKI_TEST_FOLDER_PATH = target; }, secondPeer.root);
  await showProjectPicker();
  await projectPicker.locator('[data-action=research-open-project]').click();
  await page.getByRole('heading', { name: secondPeer.title, exact: true }).waitFor();
  assert.equal(await page.locator('.research-overview p').count(), 0);
  await page.locator('[data-research-destination=rules]').click();
  const emptyDescription = await editDescription();
  assert.equal(await emptyDescription.getByLabel('项目描述', { exact: true }).inputValue(), '');
  await emptyDescription.getByLabel('项目描述', { exact: true }).fill('追踪论文的章节修改。');
  await emptyDescription.getByRole('button', { name: '保存', exact: true }).click();
  await emptyDescription.waitFor({ state: 'hidden' });
  await page.locator('[data-research-destination=timeline]').click();
  await page.locator('.research-overview p').getByText('追踪论文的章节修改。', { exact: true }).waitFor();
  assert.equal(commandAt(secondPeer.root, 'describe').project.description, '追踪论文的章节修改。');
  pass('a project without a description can add one from project settings');
  await page.locator('[data-research-phase=drafting]').click();
  assert.equal(await page.getByRole('region', { name: '结论依据', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '可视化展示', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '新建可视化展示', exact: true }).count(), 1);
  const paperEntry = page.locator('.research-entry').filter({ hasText: '方法章节修改' });
  assert.match(await paperEntry.locator('.research-entry-meta').innerText(), /章节 方法/);
  assert.doesNotMatch(await paperEntry.locator('.research-entry-meta').innerText(), /稿件版本/);
  await page.getByRole('button', { name: '新建研究记录' }).click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('[name=type]').inputValue(), 'writing');
  assert.equal(await dialog.locator('[name=field-chapter]').getAttribute('required'), '');
  assert.equal(await dialog.locator('[name=field-draft]').count(), 1);
  assert.equal(await dialog.locator('[name=field-gpu_ms]').count(), 0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  pass('a project with its own record type uses its own fields, template, instructions and view');
  assert.equal(new Set([ownerId, firstPeer.id, secondPeer.id]).size, 3);
  await switchProject(project);
  await page.locator('[data-research-destination=summaries]').click();
  await page.locator('[data-research-edit=paper-decision]').click();
  const projectChoices = dialog.getByRole('group', { name: '关联项目' });
  await projectChoices.getByRole('checkbox', { name: /复现实验项目/ }).check();
  await projectChoices.getByRole('checkbox', { name: /论文分析项目/ }).check();
  await dialog.getByRole('button', { name: '保存属性' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(new Set(command('read', ['paper-decision']).record.relatedProjects), new Set([firstPeer.id, secondPeer.id]));

  await switchProject(firstPeer.root);
  await page.locator('[data-research-destination=summaries]').click();
  const shared = page.getByRole('region', { name: '跨项目总结' }).getByRole('button', { name: /森林结果采用决定/ });
  await shared.waitFor();
  assert.match(await shared.innerText(), /原项目 实时渲染性能研究/);
  const denied = await page.evaluate(async ({ root, ownerId }) => {
    try { await window.meki.openLinkedResearchSummary(root, ownerId, 'exploration-review'); return false; }
    catch (error) { return String(error).includes('这份阶段总结在当前项目中暂不可用。'); }
  }, { root: firstPeer.root, ownerId });
  assert.equal(denied, true);
  await shared.click();
  await page.locator('#research-reader-title').getByText('森林结果采用决定').waitFor();
  assert.match(await page.locator('#research-reader-context').innerText(), /实时渲染性能研究/);
  await showReaderReferences();
  await related.getByText('论文分析项目', { exact: true }).waitFor();
  await related.getByRole('button', { name: '论文 v3' }).click();
  await inspector.locator('pre').getByText(/Four-view validation/).waitFor();
  await inspector.getByRole('button', { name: '返回正文' }).click();
  await related.getByRole('button', { name: '森林四视角报告' }).click();
  await page.locator('#research-reader-title').getByText('森林四视角报告').waitFor();
  await page.getByRole('button', { name: '返回上一份文档' }).click();
  await page.locator('#research-reader-title').getByText('森林结果采用决定').waitFor();
  await page.locator('[data-action=research-edit-body]').click();
  await sourceAppend('\n从复现实验项目补充的结论。');
  await page.locator('[data-action=save]').click();
  await idle();
  assert.match(command('read', ['paper-decision']).body, /从复现实验项目补充的结论/);
  assert.equal(commandAt(firstPeer.root, 'list', ['--type', 'stage-summary']).records.some(item => item.record.id === 'paper-decision'), false);
  await closeReader();

  await switchProject(secondPeer.root);
  await page.locator('[data-research-destination=summaries]').click();
  await shared.waitFor();
  await page.locator('[data-research-filter]').click();
  await tools.getByLabel('关键词').fill('从复现实验项目补充的结论');
  await tools.getByRole('button', { name: '应用', exact: true }).click();
  await page.locator('.research-active-filter').waitFor();
  await shared.click();
  await page.locator('#visual-editor').getByText('从复现实验项目补充的结论。').waitFor();
  await closeReader();

  await switchProject(project);
  await page.locator('[data-research-destination=summaries]').click();
  await page.locator('[data-research-edit=paper-decision]').click();
  await projectChoices.getByRole('checkbox', { name: /复现实验项目/ }).uncheck();
  await dialog.getByRole('button', { name: '保存属性' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await switchProject(firstPeer.root);
  await page.locator('[data-research-destination=summaries]').click();
  await page.locator('.research-entry-title [data-research-record=exploration-review]').waitFor();
  assert.equal(await shared.count(), 0);
  assert.deepEqual(command('read', ['paper-decision']).record.relatedProjects, [secondPeer.id]);
  assert.deepEqual(errors, []);
  pass('multiple projects open and edit one linked summary with its original evidence and can remove a link independently');

  await switchProject(project);
  await timelineView.click();
  await page.clock.setFixedTime(new Date('2026-11-19T15:59:59Z'));
  await refresh.click();
  await page.waitForFunction(() => document.querySelector('[data-research-range]')?.dataset.end === '2026-11-19');
  const phaseDialog = page.locator('#research-tools-dialog');
  async function addPhase(title, start, useRestoredFocus = false) {
    await idle();
    await openTimelineOptions();
    const open = page.getByRole('button', { name: '新建阶段', exact: true });
    if (useRestoredFocus) {
      assert.ok(await open.evaluate(button => button === document.activeElement));
      await page.keyboard.press('Enter');
    } else await open.click();
    await phaseDialog.waitFor({ state: 'visible' });
    await phaseDialog.getByLabel('阶段名称').fill(title);
    const startDate = phaseDialog.getByLabel('开始日期');
    assert.equal(await startDate.getAttribute('required'), '');
    await startDate.fill(start);
    assert.equal(await phaseDialog.getByLabel('结束日期（可选）').inputValue(), '');
    await phaseDialog.getByRole('button', { name: '保存', exact: true }).click();
    await phaseDialog.waitFor({ state: 'hidden' });
    const { id, end } = command('describe').project.phases.find(phase => phase.title === title);
    assert.equal(end, undefined);
    await phases.filter({ hasText: title }).waitFor();
    return id;
  }
  const ongoingId = await addPhase('持续实验阶段', '2026-11-18');
  const futureId = await addPhase('计划验证阶段', '2026-11-22', true);
  const ongoingRow = phases.filter({ hasText: '持续实验阶段' });
  const futureRow = phases.filter({ hasText: '计划验证阶段' });
  await ongoingRow.getByText('进行中', { exact: true }).waitFor();
  await futureRow.getByText('未开始', { exact: true }).waitFor();
  assert.equal(await futureRow.locator('[data-research-phase]').getAttribute('data-research-phase'), futureId);
  assert.equal(await futureRow.locator('.research-timeline-bar').count(), 0);
  const bar = ongoingRow.locator('.research-timeline-bar');
  const rightEdge = () => bar.evaluate(item => parseFloat(item.style.getPropertyValue('--right')));
  assert.equal(await rightEdge(), 0);
  await page.clock.setFixedTime(new Date('2026-11-19T16:00:00Z'));
  await page.waitForFunction(() => document.querySelector('[data-research-range]').dataset.end === '2026-11-20');
  assert.equal(await rightEdge(), 0);
  await ongoingRow.getByText('进行中', { exact: true }).waitFor();
  await ongoingRow.click();
  await page.getByRole('button', { name: '插入阶段总结', exact: true }).click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('[name=start]').inputValue(), '2026-11-18');
  assert.equal(await dialog.locator('[name=end]').inputValue(), '2026-11-20');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('button', { name: '编辑阶段', exact: true }).click();
  await phaseDialog.waitFor({ state: 'visible' });
  const endDate = phaseDialog.getByLabel('结束日期（可选）');
  const savePhase = phaseDialog.getByRole('button', { name: '保存', exact: true });
  await endDate.fill('2026-11-17');
  await savePhase.click();
  await phaseDialog.getByRole('alert').getByText('结束日期不能早于开始日期。').waitFor();
  await endDate.fill('2026-11-20');
  await savePhase.click();
  await phaseDialog.waitFor({ state: 'hidden' });
  assert.equal(command('describe').project.phases.find(phase => phase.id === ongoingId).end, '2026-11-20');
  await ongoingRow.getByText('进行中', { exact: true }).waitFor();
  await page.clock.setFixedTime(new Date('2026-11-20T16:00:00Z'));
  await ongoingRow.getByText('已结束', { exact: true }).waitFor();
  await futureRow.getByText('未开始', { exact: true }).waitFor();
  await page.clock.setFixedTime(new Date('2026-11-21T16:00:00Z'));
  await futureRow.getByText('进行中', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  pass('phases without an end follow the project day until an inclusive end is entered');

  const imageIds = ['mesh-canopy', 'ours-canopy', 'mesh-trunk', 'ours-trunk'];
  const images = await page.evaluate(() => ['#47779c', '#3d7658', '#42607e', '#366b67'].map((color, index) => {
    const canvas = document.createElement('canvas');
    canvas.width = index < 2 ? 640 : 400;
    canvas.height = index < 2 ? 400 : 640;
    const context = canvas.getContext('2d');
    context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#c5d8a1'; context.fillRect(70 + index * 14, 90, 300, 180);
    context.fillStyle = '#1e3746'; context.fillRect(10, 10, 80, 35);
    return canvas.toDataURL().split(',')[1];
  }));
  for (let index = 0; index < imageIds.length; index++) {
    const file = `${imageIds[index]}.png`;
    await fs.writeFile(path.join(archive, file), Buffer.from(images[index], 'base64'));
    command('index', [imageIds[index], '--source', 'archive', '--path', file]);
  }
  await futureRow.click();
  await page.getByRole('button', { name: '新建可视化展示', exact: true }).click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('[name=title]').fill('双机位 Mesh 对比');
  await dialog.locator('[name=date]').fill('2026-11-22');
  await dialog.getByLabel('第 1 行', { exact: true }).fill('树冠机位');
  await dialog.getByLabel('第 2 行', { exact: true }).fill('树干机位');
  await dialog.getByLabel('第 1 列', { exact: true }).fill('普通 Mesh');
  await dialog.getByLabel('第 2 列', { exact: true }).fill('Ours');
  for (let index = 0; index < imageIds.length; index++) await dialog.locator('[data-grid-image]').nth(index).fill(imageIds[index]);
  const captionNotes = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 轮复测使用同一组相机。`);
  await dialog.getByLabel('图注（Markdown）').fill(['**同一机位**使用相同分辨率。', ...captionNotes].join('\n\n'));
  await dialog.getByRole('button', { name: '保存展示', exact: true }).click();
  const comparison = page.locator('#research-comparison-dialog');
  await comparison.getByRole('heading', { name: '双机位 Mesh 对比', exact: true }).waitFor();
  await comparison.locator('.research-comparison-caption strong').getByText('同一机位').waitFor();
  const imagesInView = comparison.locator('.research-comparison-image img');
  await imagesInView.nth(3).waitFor();
  const fitButton = comparison.getByRole('button', { name: '适应视口', exact: true });
  const zoomSlider = comparison.getByRole('slider', { name: '缩放所有对比图' });
  const zoomPresets = comparison.getByRole('combobox', { name: '缩放倍率预设' });
  assert.equal(await fitButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await zoomPresets.inputValue(), '');
  const fitFrames = await imagesInView.evaluateAll(images => images.map(image => {
    const frame = image.parentElement.getBoundingClientRect();
    const column = image.closest('td').clientWidth;
    const galleryHeight = image.closest('.research-comparison-scroll').clientHeight;
    return { width: frame.width, height: frame.height, column, galleryHeight, ratio: image.naturalWidth / image.naturalHeight };
  }));
  for (const frame of fitFrames) {
    assert.ok(Math.abs(frame.width - frame.ratio * frame.height) < 1, JSON.stringify(frame));
    assert.ok(frame.width >= frame.column * .95 || frame.height >= frame.galleryHeight * .75, JSON.stringify(frame));
  }
  const comparisonWindow = await app.browserWindow(page);
  const previousSize = await comparisonWindow.evaluate(win => win.getContentSize());
  await comparisonWindow.evaluate(win => win.setContentSize(780, 480));
  await page.waitForFunction(() => innerWidth === 780 && innerHeight === 480);
  const compactGrid = await comparison.evaluate(dialog => {
    const grid = dialog.querySelector('.research-comparison-scroll');
    grid.scrollTop = grid.scrollHeight;
    const visible = grid.getBoundingClientRect();
    const lastNote = grid.querySelector('.research-comparison-caption p:last-child').getBoundingClientRect();
    const lastSource = grid.querySelector('tr:last-child td:last-child [data-comparison-source]');
    lastSource.scrollIntoView({ block: 'nearest' });
    const source = lastSource.getBoundingClientRect();
    const box = dialog.getBoundingClientRect();
    return { top: box.top, bottomGap: innerHeight - box.bottom, titlebar: navigator.windowControlsOverlay?.getTitlebarAreaRect().bottom || 0,
      outerOverflow: dialog.scrollHeight - dialog.clientHeight, scrolled: grid.scrollTop, galleryHeight: visible.height,
      captionReachable: lastNote.top >= visible.top - 1 && lastNote.bottom <= visible.bottom + 1, lastImageReachable: source.top >= visible.top - 1 && source.bottom <= visible.bottom + 1 };
  });
  assert.ok(compactGrid.top >= compactGrid.titlebar - 1 && compactGrid.bottomGap > 0, JSON.stringify(compactGrid));
  assert.ok(compactGrid.outerOverflow <= 1 && compactGrid.galleryHeight > 240 && compactGrid.scrolled > 0 && compactGrid.captionReachable && compactGrid.lastImageReachable, JSON.stringify(compactGrid));
  const comparisonGallery = comparison.locator('.research-comparison-scroll');
  await comparison.locator('[data-comparison-layout="wipe"]').click();
  await comparison.getByRole('slider').waitFor();
  assert.equal(await comparisonGallery.evaluate(node => node.scrollTop), 0);
  await comparison.locator('[data-comparison-layout="grid"]').click();
  assert.equal(await comparisonGallery.evaluate(node => node.scrollTop), compactGrid.scrolled);
  await comparisonGallery.evaluate(node => { node.scrollTop = 0; });
  await comparisonWindow.evaluate((win, size) => win.setContentSize(...size), previousSize);
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h &&
    [...document.querySelectorAll('#research-comparison-dialog .research-comparison-image img')].every(image => {
      const viewport = image.closest('[data-image-evidence]');
      const fitted = Math.min(viewport.clientWidth, viewport.clientHeight * image.naturalWidth / image.naturalHeight);
      return Math.abs(parseFloat(image.style.width) - fitted) < 0.01;
    }), previousSize);
  for (const text of ['普通 Mesh', 'Ours', '树冠机位', '树干机位']) await comparison.getByRole(text.includes('机位') ? 'rowheader' : 'columnheader', { name: text }).waitFor();
  const imageState = () => imagesInView.evaluateAll(elements => elements.map(image => {
    const matrix = new DOMMatrix(image.style.transform);
    return { width: parseFloat(image.style.width), x: matrix.m41, y: matrix.m42 };
  }));
  const fit = await imageState();
  const firstTile = comparison.locator('[data-image-evidence]').first();
  await firstTile.hover();
  await page.mouse.wheel(0, -170);
  await page.waitForFunction(width => parseFloat(document.querySelector('.research-comparison-image img').style.width) > width, fit[0].width);
  const zoomed = await imageState();
  assert.equal(zoomed[0].width, zoomed[1].width);
  assert.deepEqual(zoomed.slice(2), fit.slice(2));
  const imageBounds = await firstTile.boundingBox();
  await page.mouse.move(imageBounds.x + imageBounds.width / 2, imageBounds.y + imageBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(imageBounds.x + imageBounds.width / 2 + 24, imageBounds.y + imageBounds.height / 2 + 12, { steps: 3 });
  await page.mouse.up();
  const panned = await imageState();
  assert.notEqual(panned[0].x, zoomed[0].x);
  for (const axis of ['x', 'y']) assert.ok(Math.abs((panned[0][axis] - zoomed[0][axis]) - (panned[1][axis] - zoomed[1][axis])) < 0.001);
  assert.deepEqual(panned.slice(2), fit.slice(2));
  const verifyPixelZoom = async level => {
    const results = await imagesInView.evaluateAll((images, level) => images.map(image => {
      const bounds = image.getBoundingClientRect();
      const near = (a, b) => Math.abs(a - b) < 0.04;
      const onPixel = value => near(value * devicePixelRatio, Math.round(value * devicePixelRatio));
      return near(parseFloat(image.style.width) * devicePixelRatio, image.naturalWidth * level)
        && near(parseFloat(image.style.height) * devicePixelRatio, image.naturalHeight * level)
        && (!Number.isInteger(level) || (image.style.imageRendering === 'pixelated' && onPixel(bounds.left) && onPixel(bounds.top)));
    }), level);
    assert.deepEqual(results, [true, true, true, true], `Images at ${level * 100}% on this display`);
  };
  for (const level of [1, 2, 4]) {
    await zoomPresets.selectOption(String(level));
    await verifyPixelZoom(level);
    assert.equal(await zoomSlider.getAttribute('aria-valuetext'), `${level * 100}%`);
    assert.equal(await zoomSlider.evaluate(input => 2 ** input.valueAsNumber), level);
    assert.equal(await fitButton.getAttribute('aria-pressed'), 'false');
  }
  const at400 = await imageState();
  await firstTile.press('=');
  const beyond400 = await imageState();
  assert.ok(beyond400[0].width > at400[0].width);
  assert.equal(beyond400[0].width, beyond400[1].width);
  assert.deepEqual(beyond400.slice(2), at400.slice(2));
  assert.equal(await zoomSlider.getAttribute('aria-valuetext'), '500%');
  assert.equal(await zoomPresets.inputValue(), '');
  const sliderBox = await zoomSlider.boundingBox();
  const sliderY = sliderBox.y + sliderBox.height / 2;
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.4, sliderY);
  await page.mouse.down();
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.6, sliderY, { steps: 5 });
  await page.mouse.up();
  const draggedZoom = await zoomSlider.evaluate(input => 2 ** input.valueAsNumber);
  assert.ok(draggedZoom > 2 && draggedZoom < 8);
  await verifyPixelZoom(draggedZoom);
  await zoomSlider.press('ArrowLeft');
  const keyboardZoom = await zoomSlider.evaluate(input => 2 ** input.valueAsNumber);
  assert.ok(keyboardZoom < draggedZoom);
  await verifyPixelZoom(keyboardZoom);
  await fitButton.click();
  assert.deepEqual(await imageState(), fit);
  assert.equal(await fitButton.getAttribute('aria-pressed'), 'true');
  await zoomPresets.selectOption('1');
  await comparison.screenshot({ path: path.join(folder, 'image-comparison.png'), animations: 'disabled' });
  await comparison.getByRole('button', { name: '打开原图' }).first().click();
  await tools.locator('img[alt="mesh-canopy.png"]').waitFor();
  await tools.getByRole('button', { name: '返回对比', exact: true }).click();
  await comparison.locator('[data-comparison-layout="wipe"]').click();
  const divider = comparison.getByRole('slider', { name: '图像对比分界线' });
  await divider.waitFor();
  const stage = await comparison.locator('.research-wipe-stage').boundingBox();
  assert.ok(Math.abs(stage.width - stage.height * 640 / 400) < 1);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal(await divider.getAttribute('aria-valuenow'), '70');
  await divider.press('ArrowLeft');
  await comparison.locator('[data-wipe-row]').selectOption('1');
  const trunkImage = comparison.locator('[data-wipe-side="left"]');
  await trunkImage.getByAltText('mesh-trunk.png').waitFor();
  const portraitStage = await comparison.locator('.research-wipe-stage').boundingBox();
  assert.ok(Math.abs(portraitStage.width - portraitStage.height * 400 / 640) < 1);
  await trunkImage.click({ position: { x: 20, y: 30 } });
  await tools.locator('img[alt="mesh-trunk.png"]').waitFor();
  await tools.getByRole('button', { name: '返回对比' }).click();
  assert.ok(await trunkImage.evaluate(node => node === document.activeElement));
  assert.equal(await divider.getAttribute('aria-valuenow'), '69');
  await comparison.locator('[data-comparison-layout="grid"]').click();
  await comparison.getByRole('button', { name: '关闭可视化展示' }).click();
  const saved = command('list', ['--phase', futureId, '--type', command('describe').format.comparison.type]).records[0].record;
  assert.deepEqual(saved.comparison.rows.flatMap(row => row.images), imageIds);
  const pair = page.locator('.research-comparison-entry').filter({ has: page.locator(`[data-research-record="${saved.id}"]`) }).locator('.research-sample-pair');
  await pair.scrollIntoViewIfNeeded();
  await pair.locator('img').nth(1).waitFor();
  assert.deepEqual(await pair.locator('figcaption').allTextContents(), ['普通 Mesh', 'Ours']);
  await pair.locator('img').first().click({ force: true });
  await comparison.getByRole('heading', { name: '双机位 Mesh 对比' }).waitFor();
  await comparison.getByRole('button', { name: '关闭可视化展示' }).click();
  await futureRow.getByRole('button', { name: '打开可视化展示 双机位 Mesh 对比', exact: true }).click();
  await comparison.locator('.research-comparison-caption strong').getByText('同一机位').waitFor();
  await comparison.getByRole('button', { name: '编辑图注', exact: true }).click();
  await page.locator('#visual-editor strong').getByText('同一机位').waitFor();
  await sourceAppend('\n\n补充对比说明。');
  await page.locator('[data-action=save]').click();
  await idle();
  assert.match(command('read', [saved.id]).body, /补充对比说明。/);
  await closeReader();
  assert.deepEqual(errors, []);
  pass('phase comparisons retain evidence and Markdown captions, link zoom and pan within rows, and open original pixels');

  const citedSummary = command('read', ['exploration-review']);
  command('batch', [], { records: [{ id: citedSummary.record.id, ifRevision: citedSummary.revision, sources: [...citedSummary.record.sources, saved.id] }] });
  await page.locator('[data-research-destination="summaries"]').click();
  const summaryEntry = page.locator('.research-entry-title [data-research-record="exploration-review"]');
  await idle();
  const clickedDuringRefresh = await summaryEntry.evaluate(button => {
    document.querySelector('#research-workspace [data-action="refresh"]').click();
    const refreshing = document.body.classList.contains('is-busy');
    button.click();
    return refreshing;
  });
  assert.ok(clickedDuringRefresh, 'The record click must overlap the pending refresh');
  const inline = page.locator('#document-scroll .research-wipe');
  await inline.getByRole('slider').waitFor();
  const headerHeight = await page.locator('.research-reader-header').evaluate(node => node.getBoundingClientRect().height);
  await page.locator('#document-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.locator('.research-reader-heading.body-title-visible').waitFor();
  await page.locator('#document-scroll').evaluate(node => {
    const heading = node.querySelector('.ProseMirror > h1');
    node.scrollTop = Math.ceil(heading.getBoundingClientRect().bottom - node.getBoundingClientRect().top) + 16;
  });
  await page.locator('.research-reader-heading:not(.body-title-visible)').waitFor();
  assert.equal(await page.locator('.research-reader-header').evaluate(node => node.getBoundingClientRect().height), headerHeight);
  await page.locator('#document-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.locator('.research-reader-heading.body-title-visible').waitFor();
  assert.ok(await inline.evaluate(figure => {
    const slot = figure.closest('.research-inline-comparisons');
    return slot.parentElement.classList.contains('ProseMirror') && slot.previousElementSibling?.tagName === 'P'
      && Boolean(slot.parentElement.querySelector('h1').compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await inline.locator('[data-wipe-row]').selectOption('1');
  await inline.locator('[data-wipe-side="right"] img[alt="ours-trunk.png"]').waitFor();
  const inlinePortrait = await inline.locator('.research-wipe-stage').boundingBox();
  assert.ok(Math.abs(inlinePortrait.width - inlinePortrait.height * 400 / 640) < 1);
  await inline.getByRole('slider').press('Home');
  await inline.locator('[data-wipe-side="right"]').click();
  await inspector.getByRole('button', { name: '返回正文' }).click();
  assert.equal(await inline.getByRole('slider').getAttribute('aria-valuenow'), '0');
  assert.ok(await inline.locator('[data-wipe-side="right"]').evaluate(node => node === document.activeElement));
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '完成编辑', exact: true }).waitFor();
  await inline.waitFor({ state: 'detached' });
  await page.locator('[data-mode="source"]').click();
  const markdown = await page.locator('#source-editor .cm-content').innerText();
  assert.match(markdown, /# 方案探索阶段总结/);
  assert.doesNotMatch(markdown, /research-inline-comparisons|图像对比分界线/);
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  await inline.getByRole('slider').waitFor();
  assert.equal(await inline.getByRole('slider').getAttribute('aria-valuenow'), '0');
  assert.equal(await inline.locator('[data-wipe-row]').inputValue(), '1');
  await closeReader();
  await timelineView.click();
  await rangeButton.waitFor();
  pass('a cited comparison can be scrubbed in the record and opened at its original image');

  const beforeBackfill = await phaseOrder();
  const sameDay = '2026-11-04';
  const titles = ['基线图像对比 A', '基线图像对比 B'];
  command('batch', [], { records: titles.map((title, index) => ({
    id: `baseline-display-${index}`, ifRevision: null, title, type: saved.type, phaseId: 'baseline',
    date: sameDay, comparison: saved.comparison, body: '历史展示图注',
  })) });
  await idle();
  await refresh.click();
  const baseline = phases.filter({ hasText: '基线测量' });
  const marker = baseline.getByRole('button', { name: `${sameDay} 的 2 条可视化展示`, exact: true });
  await marker.waitFor();
  assert.equal(await baseline.locator('.research-timeline-comparison').count(), 1);
  assert.deepEqual(await phaseOrder(), beforeBackfill);
  const dot = baseline.locator('.research-timeline-dot.is-ended');
  assert.equal(await dot.count(), 1);
  const [iconBox, dotBox] = await Promise.all([marker.boundingBox(), dot.boundingBox()]);
  assert.ok(Math.abs(iconBox.x + iconBox.width / 2 - dotBox.x - dotBox.width / 2) < 1);
  await page.locator('.research-timeline').screenshot({ path: path.join(folder, 'timeline-comparisons.png'), animations: 'disabled' });
  for (const title of titles) {
    await marker.click();
    await tools.getByRole('heading', { name: `${sameDay} 的可视化展示`, exact: true }).waitFor();
    await tools.getByRole('button', { name: title, exact: true }).click();
    await comparison.getByRole('heading', { name: title, exact: true }).waitFor();
    await comparison.getByRole('button', { name: '关闭可视化展示' }).click();
    assert.equal(await baseline.locator('[data-research-phase]').getAttribute('aria-pressed'), 'false');
  }
  pass('same-day backfilled comparisons appear once, align with the finished experiment dot and open individually');

  await openTimelineOptions();
  await page.locator('[data-research-event-types]').click();
  const eventTypeRow = tools.locator('[data-event-type=group-meeting]');
  await eventTypeRow.getByRole('button', { name: '选择图标' }).click();
  const gallery = tools.getByRole('group', { name: '备选图标' });
  assert.equal(await gallery.getByRole('button').count(), 16);
  await gallery.getByRole('button', { name: '讨论', exact: true }).click();
  await tools.getByRole('button', { name: '添加类型' }).click();
  const newType = tools.locator('.research-event-type-row').last();
  await newType.getByLabel('类型名称').fill('论文审阅');
  await newType.getByRole('button', { name: '选择图标' }).click();
  await gallery.getByRole('button', { name: '文档', exact: true }).click();
  await tools.getByRole('button', { name: '保存', exact: true }).click();
  await tools.waitFor({ state: 'hidden' });
  const eventConfig = command('describe');
  assert.equal(eventConfig.format.timeline.events.icons.length, 16);
  assert.equal(eventConfig.project.recordTypes.find(type => type.id === 'group-meeting').icon, 'people');
  const review = eventConfig.project.recordTypes.find(type => type.label === '论文审阅');
  assert.deepEqual([review.kind, review.icon], ['event', 'page']);

  await openTimelineOptions();
  await page.getByRole('button', { name: '添加事件', exact: true }).click();
  await dialog.locator('[name=type]').selectOption(review.id);
  await dialog.locator('[name=phaseId]').selectOption('baseline');
  await dialog.locator('[name=title]').fill('基线评测审阅');
  await dialog.locator('[name=date]').fill(sameDay);
  await dialog.getByRole('button', { name: '创建并编辑' }).click();
  await page.locator('#research-reader-title').getByText('基线评测审阅').waitFor();
  assert.equal(command('list', ['--type', review.id]).records[0].record.date, sameDay);
  await closeReader();
  const mixed = baseline.getByRole('button', { name: `${sameDay} 的 3 个事件` });
  await mixed.waitFor();
  assert.equal(await mixed.locator('svg').count(), 2);
  assert.match(await mixed.innerText(), /\+1/);

  const validationPhase = page.locator('[data-research-phase=validation]');
  await validationPhase.click();
  assert.match(await page.locator('.research-phase-details').innerText(), /补采同视角基线/);
  assert.equal(await page.locator('[data-research-goal]').count(), 0);
  const setGoals = async (mode, widths) => {
    await page.locator('[data-research-destination=rules]').click();
    await page.getByRole('button', { name: '时间线设置' }).click();
    await tools.locator('[name=goals]').selectOption(mode);
    if (widths) {
      await tools.locator('[name=workspace]').selectOption(widths);
      await tools.locator('[name=comparison]').selectOption(widths);
    }
    await tools.getByRole('button', { name: '保存', exact: true }).click();
    await tools.waitFor({ state: 'hidden' });
    await timelineView.click();
  };
  await setGoals('checklist', 'comfort');
  assert.equal(await page.locator('#research-workspace').getAttribute('data-width'), 'comfort');
  const goal = page.locator('[data-research-goal="0"]');
  await goal.check();
  await page.waitForFunction(() => document.querySelector('[data-research-goal="0"]')?.matches(':checked:enabled'));
  assert.equal(command('describe').project.phases.find(phase => phase.id === 'validation').goals[0].done, true);
  await setGoals('hidden');
  assert.equal(await page.getByRole('heading', { name: '阶段目标', exact: true }).count(), 0);
  await setGoals('checklist');
  assert.equal(await goal.isChecked(), true);
  await mixed.click();
  await tools.getByRole('heading', { name: `${sameDay} 的事件` }).waitFor();
  await tools.getByRole('button', { name: titles[0], exact: true }).click();
  await comparison.waitFor({ state: 'visible' });
  assert.equal(await comparison.getAttribute('data-width'), 'comfort');
  await comparison.getByRole('button', { name: '返回事件列表' }).click();
  await tools.getByRole('button', { name: '基线评测审阅', exact: true }).click();
  await page.locator('#research-reader-title').getByText('基线评测审阅').waitFor();
  await closeReader();
  const legendContents = await legend.innerHTML();
  assert.deepEqual(await markerLegend.locator('span').allTextContents(), ['阶段时段', '实验日期', '今天']);
  assert.deepEqual(await eventLegend.locator('.research-key-event').allTextContents(), ['组会汇报', '可视化展示', '论文审阅']);
  assert.equal(await eventLegend.evaluate(node => getComputedStyle(node).borderInlineStartWidth), '1px');
  const [markerBox, eventBox] = await Promise.all([markerLegend.boundingBox(), eventLegend.boundingBox()]);
  assert.ok(eventBox.x > markerBox.x + markerBox.width);
  await legend.screenshot({ path: path.join(folder, 'timeline-legend-wide.png'), animations: 'disabled' });
  const week = quickRange('最近 7 天');
  await week.scrollIntoViewIfNeeded();
  const weekBox = await week.boundingBox();
  await page.mouse.move(weekBox.x + weekBox.width / 2, weekBox.y + weekBox.height / 2);
  await page.mouse.down();
  command('batch', [], { records: [{ id: 'follow-up', type: review.id, title: '基线后续审阅', date: '2026-11-18', phaseId: 'baseline' }] });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-research-range-preset="7d"]')?.getAttribute('aria-pressed') === 'true');
  const followUp = baseline.getByRole('button', { name: '打开事件 基线后续审阅' });
  await followUp.waitFor();
  assert.equal(await baseline.locator('.research-timeline-bar').count(), 0);
  assert.equal(await legend.innerHTML(), legendContents);
  assert.deepEqual(errors, []);
  pass('project event icons, same-day drill-down, both width preferences and optional saved goals work end to end');

  const todayLine = page.locator('.research-today-line');
  assert.ok(await todayLine.count());
  const selectedPhase = baseline.locator('[data-research-phase]');
  await selectedPhase.click();
  assert.equal(await selectedPhase.getAttribute('aria-pressed'), 'true');
  const latestMarker = page.locator('.research-timeline-event[data-latest-event]');
  assert.equal(await latestMarker.getAttribute('data-research-timeline-events'), 'follow-up');
  assert.equal(await followUp.getAttribute('aria-description'), '本阶段最近事件');
  await ruler.scrollIntoViewIfNeeded();
  const axisTop = (await ruler.boundingBox()).y;
  const positions = () => phases.evaluateAll(rows => rows.map(row => {
    const { top, height } = row.getBoundingClientRect();
    return { top, height };
  }));
  const beforePan = await positions();
  const orderBeforePan = await phaseOrder();
  await pan(.1, .9);
  assert.ok((await rangeButton.getAttribute('data-end')) < '2026-11-18');
  assert.equal(await todayLine.count(), 0);
  assert.equal(await followUp.count(), 0);
  assert.equal(await latestMarker.count(), 0);
  assert.equal(await legend.innerHTML(), legendContents);
  assert.equal((await ruler.boundingBox()).y, axisTop);
  assert.deepEqual(await phaseOrder(), orderBeforePan);
  assert.deepEqual(await positions(), beforePan);
  assert.equal(await selectedPhase.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#research-journal-title').innerText(), '基线测量');
  await week.click();
  await followUp.waitFor();
  assert.equal(await latestMarker.getAttribute('data-research-timeline-events'), 'follow-up');
  assert.ok(await todayLine.count());
  assert.equal(await legend.innerHTML(), legendContents);
  assert.deepEqual(errors, []);
  pass('timeline legend, phase rows and selection stay fixed while panning past today and the last visible event');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(520, 760));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.research-legend-events')).borderBlockStartWidth === '1px');
  assert.equal(await eventLegend.evaluate(node => getComputedStyle(node).borderInlineStartWidth), '0px');
  const [stackedMarkers, stackedEvents] = await Promise.all([markerLegend.boundingBox(), eventLegend.boundingBox()]);
  assert.equal(stackedEvents.x, stackedMarkers.x);
  assert.ok(stackedEvents.y > stackedMarkers.y + stackedMarkers.height);
  assert.equal(await legend.innerHTML(), legendContents);
  await legend.screenshot({ path: path.join(folder, 'timeline-legend-narrow.png'), animations: 'disabled' });
  pass('timeline markers and custom events switch from a vertical divider to stacked groups in narrow layouts');

  await quickRange('最近 14 天').click();
  command('batch', [], { records: [
    { id: 'adjacent-meeting', type: 'group-meeting', title: '复测讨论', date: '2026-11-18', phaseId: ongoingId },
    { id: 'adjacent-review', type: review.id, title: '次日审阅', date: '2026-11-19', phaseId: ongoingId },
  ] });
  await refresh.click();
  const combined = ongoingRow.getByRole('button', { name: '2026-11-18 – 2026-11-19 的 2 个事件', exact: true });
  const firstEvent = ongoingRow.getByRole('button', { name: '打开事件 复测讨论', exact: true });
  const nextEvent = ongoingRow.getByRole('button', { name: '打开事件 次日审阅', exact: true });
  await combined.waitFor();
  await ongoingRow.locator('[data-research-phase]').click();
  assert.equal(await latestMarker.getAttribute('data-research-timeline-events'), 'adjacent-meeting adjacent-review');
  assert.equal(await combined.locator('svg').count(), 1);
  assert.equal(await combined.locator('small').innerText(), '+1');
  await combined.click();
  await tools.getByRole('heading', { name: '2026-11-18 – 2026-11-19 的事件' }).waitFor();
  assert.deepEqual(await tools.locator('[data-research-event-choice] small').allTextContents(), ['2026-11-18 · 组会汇报', '2026-11-19 · 论文审阅']);
  await page.keyboard.press('Escape');
  await tools.waitFor({ state: 'hidden' });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const motion = await page.evaluateHandle(phase => {
    const calls = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.closest(`[data-phase="${phase}"]`)) calls.push(this.dataset.researchTimelineEvents);
      return animate.call(this, frames, options);
    };
    return { calls, restore: () => { Element.prototype.animate = animate; } };
  }, ongoingId);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820));
  await firstEvent.waitFor();
  await nextEvent.waitFor();
  assert.equal(await combined.count(), 0);
  assert.equal(await latestMarker.getAttribute('data-research-timeline-events'), 'adjacent-review');
  assert.equal(await nextEvent.evaluate(el => getComputedStyle(el, '::after').animationIterationCount), 'infinite');
  assert.ok(await motion.evaluate(probe => ['adjacent-meeting', 'adjacent-review'].every(id => probe.calls.includes(id))));
  await ongoingRow.screenshot({ path: path.join(folder, 'timeline-events-split.png'), animations: 'disabled' });
  const [firstBox, nextBox] = await Promise.all([firstEvent.boundingBox(), nextEvent.boundingBox()]);
  assert.equal(firstBox.y, nextBox.y);
  assert.ok(firstBox.x + firstBox.width < nextBox.x);

  await firstEvent.focus();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(520, 760));
  await combined.waitFor();
  assert.ok(await combined.evaluate(button => button === document.activeElement));
  assert.ok(await motion.evaluate(probe => probe.calls.includes('adjacent-meeting adjacent-review')));
  await ongoingRow.screenshot({ path: path.join(folder, 'timeline-events-merged.png'), animations: 'disabled' });

  await rangeButton.click();
  await rangePicker.getByLabel('开始日期').fill('2026-11-18');
  await rangePicker.getByLabel('结束日期').fill('2026-11-19');
  await applyRange.click();
  await firstEvent.waitFor();
  await nextEvent.waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animationsBeforeZoom = await motion.evaluate(probe => probe.calls.length);
  const zoomOut = page.getByRole('button', { name: '缩小时间轴', exact: true });
  for (let i = 0; i < 6 && !await combined.count(); i++) await zoomOut.click();
  await combined.waitFor();
  assert.equal(await motion.evaluate(probe => probe.calls.length), animationsBeforeZoom);
  assert.equal(await latestMarker.getAttribute('data-research-timeline-events'), 'adjacent-meeting adjacent-review');
  assert.deepEqual(await latestMarker.evaluate(el => {
    const edge = getComputedStyle(el, '::after');
    return [edge.animationName, edge.opacity, edge.pointerEvents];
  }), ['none', '1', 'none']);
  await motion.evaluate(probe => probe.restore());
  await motion.dispose();
  pass('adjacent event dates merge without extra rows, split on resize or zoom, and honor reduced motion');

  const pdfReport = path.join(archive, 'GPU.pdf'), slidesReport = path.join(archive, 'GPU.PPTX');
  await writeReportPdf(pdfReport);
  await writeReportPptx(slidesReport);
  command('index', ['gpu-report-pdf', '--source', 'archive', '--path', 'GPU.pdf']);
  command('index', ['gpu-report-slides', '--source', 'archive', '--path', 'GPU.PPTX']);
  command('batch', [], { records: [
    { id: 'pdf-briefing', type: 'group-meeting', phaseId: 'validation', date: '2026-11-14',
      title: '性能汇报 PDF', fields: {}, body: '# 性能汇报 PDF\n\n[原始汇报][deck]\n\n[deck]: mekir:gpu-report-pdf\n' },
    { id: 'slide-briefing', type: 'group-meeting', phaseId: 'validation', date: '2026-11-14',
      title: '复测汇报 PPTX', fields: {}, evidence: ['gpu-report-slides'], body: '# 复测汇报 PPTX\n\n保留事件正文。\n' },
  ] });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 540));
  await refresh.click();
  await idle();
  await page.locator('[data-research-reset-range]').click();
  const activePhase = page.locator('[data-research-phase="validation"]');
  if (await activePhase.getAttribute('aria-pressed') !== 'true') await activePhase.click();
  const briefingSelector = '[data-research-timeline-events~="pdf-briefing"][data-research-timeline-events~="slide-briefing"]';
  const briefing = page.locator(briefingSelector);
  await briefing.scrollIntoViewIfNeeded();
  const timelinePosition = await researchScroll.evaluate(element => element.scrollTop);
  const dateRange = await rangeButton.innerText();
  const report = page.locator('#research-report-dialog');
  async function openBriefing(title) {
    await briefing.click();
    await page.locator('#research-tools-dialog').getByRole('button', { name: title }).click();
    await report.waitFor();
  }
  async function readyReportPage(number) {
    await report.locator('#research-report-page').getByText(`第 ${number} 页，共 3 页`, { exact: true }).waitFor();
    await report.locator('.research-report-stage[aria-busy=false]').waitFor();
    assert.equal(await report.locator('#research-report-status').isVisible(), false);
  }
  async function closeBriefing() {
    await report.getByRole('button', { name: '关闭汇报预览' }).click();
    await report.waitFor({ state: 'hidden' });
    assert.equal(await researchScroll.evaluate(element => element.scrollTop), timelinePosition);
    assert.equal(await rangeButton.innerText(), dateRange);
    assert.equal(await activePhase.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(selector => document.activeElement?.matches(selector), briefingSelector);
  }
  await openBriefing('性能汇报 PDF');
  const colors = [];
  for (const number of [1, 2, 3]) {
    await readyReportPage(number);
    colors.push(await report.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(20, 20, 1, 1).data].join(',')));
    if (number < 3) await report.locator('[data-report-next]').click();
  }
  assert.equal(new Set(colors).size, 3);
  assert.equal(await report.locator('[data-report-next]').isDisabled(), true);
  await report.locator('[data-report-prev]').click();
  await readyReportPage(2);
  await report.locator('[data-report-prev]').click();
  await readyReportPage(1);
  assert.equal(await report.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(20, 20, 1, 1).data].join(',')), colors[0]);
  await report.getByRole('button', { name: '定位原文件' }).click();
  await report.screenshot({ path: path.join(folder, 'report-pdf.png'), animations: 'disabled' });
  await closeBriefing();

  const externalReportRequests = [];
  page.on('request', request => {
    if (request.url().startsWith('https://report-preview.invalid/')) externalReportRequests.push(request.url());
  });
  await openBriefing('复测汇报 PPTX');
  const nextSlide = report.locator('[data-report-next]');
  for (const [index, title] of ['First', 'Second', 'Third'].entries()) {
    await readyReportPage(index + 1);
    assert.match(await report.locator('.research-report-document').textContent(), new RegExp(`${title} report slide`));
    if (index < 2) await nextSlide.press('Enter');
  }
  assert.ok(await report.evaluate(dialog => dialog.contains(document.activeElement)));
  await page.keyboard.press('ArrowLeft');
  await readyReportPage(2);
  await page.keyboard.press('ArrowLeft');
  await readyReportPage(1);
  assert.deepEqual(externalReportRequests, []);
  await report.screenshot({ path: path.join(folder, 'report-pptx.png'), animations: 'disabled' });
  await closeBriefing();
  await openBriefing('复测汇报 PPTX');
  await readyReportPage(1);
  await report.getByRole('button', { name: '查看事件正文' }).click();
  await page.locator('#research-reader-title').getByText('复测汇报 PPTX', { exact: true }).waitFor();
  await closeReader();
  pass('same-day reports reveal and preview indexed PPTX/PDF pages in original order, preserving the timeline and event note');

  const navDivider = () => page.getByRole('separator', { name: '调整项目导航宽度' });
  const listDivider = () => page.getByRole('separator', { name: '调整记录列表与预览宽度' });
  const widths = () => page.evaluate(() => ['.shell > .sidebar', '#research-workspace', '#document-surface']
    .map(selector => Math.round(document.querySelector(selector).getBoundingClientRect().width)));
  const sizeWindow = width => app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width);
  async function openColumns() {
    await page.locator('[data-research-destination="entries"]').click();
    await page.locator('.research-entry-title [data-research-record]').first().click();
    await listDivider().waitFor();
    await idle();
  }
  const dividerStyle = handle => handle.evaluate(async el => {
    await Promise.allSettled(el.getAnimations({ subtree: true }).map(animation => animation.finished));
    const grip = getComputedStyle(el, '::after');
    return { height: grip.height, color: grip.backgroundColor, outline: grip.outlineStyle, line: getComputedStyle(el, '::before').backgroundColor };
  });
  async function dragWidth(handle, change, cancel = false) {
    const { x, y, width, height } = await handle.boundingBox();
    await page.mouse.move(x + width / 2, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(x + width / 2 + change, y + height / 2, { steps: 4 });
    assert.notEqual((await dividerStyle(handle)).color, restingStyle.color);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.mouse.move(80, 200);
    assert.deepEqual(await dividerStyle(handle), restingStyle, 'moving away returns the divider to rest without a click');
  }
  await sizeWindow(1280);
  await navDivider().waitFor();
  assert.equal(await listDivider().count(), 0);
  const pageHeading = page.locator('.research-overview h1');
  const wideTitle = await pageHeading.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.equal(wideTitle, 24);
  await navDivider().press('End');
  const narrowTitle = await pageHeading.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(narrowTitle >= 20 && narrowTitle < wideTitle, 'heading follows the research column as it narrows inside the same window');
  for (const selector of ['[data-research-range-preset]', '[data-research-destination="timeline"]']) {
    const clearance = await page.locator(selector).first().evaluate(el => el.clientHeight - parseFloat(getComputedStyle(el).lineHeight));
    assert.ok(clearance >= 10, `${selector} needs vertical space around its label`);
  }
  await navDivider().press('Enter');
  assert.equal(await pageHeading.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), wideTitle);
  pass('research headings adapt to the column and navigation and date controls leave room around their labels');
  const typePhase = page.locator('.research-timeline-row [data-research-phase="validation"]');
  if (await typePhase.getAttribute('aria-pressed') !== 'true') await typePhase.click();
  await openAppearance();
  await page.locator('#theme-choices button[data-theme="kraft"]').click();
  await page.getByRole('radio', { name:'应用界面' }).check();
  const font = page.getByRole('combobox', { name:'界面字体', exact:true });
  const previousFont = await font.inputValue();
  const uiSize = page.getByLabel('界面基准字号', {exact:true});
  const previousUiSize = await uiSize.inputValue();
  const typography = selector => page.locator(selector).first().evaluate(node => {
    const {fontFamily, fontSize} = getComputedStyle(node);
    return {family:fontFamily, size:parseFloat(fontSize)};
  });
  const interfaceLabels = ['.research-overview h1', '[data-research-destination="timeline"] span', '.research-timeline-label strong',
    '.research-phase-range', '.research-stage-detail .research-progress-conclusion', '#research-experiments-title'];
  const originalTypography = await Promise.all(interfaceLabels.map(typography));
  const documentText = await typography('#visual-editor .ProseMirror');
  await font.selectOption('kai');
  await uiSize.fill('18');
  for (const [index, selector] of interfaceLabels.entries()) {
    const {family, size} = await typography(selector);
    assert.match(family, /Kaiti SC/, selector);
    assert.ok(Math.abs(size - originalTypography[index].size * 18 / Number(previousUiSize)) < .15, selector);
  }
  assert.deepEqual(await typography('#visual-editor .ProseMirror'), documentText);
  await uiSize.fill(previousUiSize);
  await font.selectOption(previousFont);
  await page.getByRole('radio', {name:'文档正文'}).check();
  pass('interface type scales the sidebar, timeline dates, phase conclusion and experiment list independently of the report');
  await page.locator('.research-toolbar').evaluate(toolbar => toolbar.click());
  await openColumns();
  for (const selector of ['.research-content', '#document-scroll']) {
    const texture = await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundImage);
    assert.match(texture, /^url\(/);
    assert.doesNotMatch(texture, /gradient\(/);
  }
  assert.equal(await listDivider().evaluate(el => getComputedStyle(el, '::before').width), '1px');
  assert.equal(await page.locator('#document-scroll .milkdown').evaluate(el => getComputedStyle(el).boxShadow), 'none');
  const [nav, list, preview] = await widths();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(80, 200);
  const restingStyle = await dividerStyle(listDivider());
  await navDivider().press('Enter');
  assert.notEqual((await dividerStyle(navDivider())).outline, 'none');
  await dragWidth(navDivider(), 48);
  assert.deepEqual(await widths(), [nav + 48, list - 48, preview]);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.notEqual((await dividerStyle(navDivider())).outline, 'none');
  await listDivider().press('Enter');
  await dragWidth(listDivider(), 72);
  const adjusted = [nav + 48, list + 24, preview - 72];
  assert.deepEqual(await widths(), adjusted);
  await dragWidth(listDivider(), -36, true);
  assert.deepEqual(await widths(), adjusted);
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await widths(), [adjusted[0], adjusted[1] - 12, adjusted[2] + 12]);
  assert.notEqual((await dividerStyle(listDivider())).outline, 'none');
  await listDivider().press('ArrowRight');
  const duringFold = await page.getByRole('button', { name: '收起侧栏', exact: true }).evaluate(toggle => {
    toggle.click();
    const sidebar = document.querySelector('#app-sidebar');
    const animation = sidebar.getAnimations()[0];
    animation.currentTime = Number(animation.effect.getTiming().duration) * .6;
    return { nav: sidebar.offsetWidth, preview: document.querySelector('#document-surface').offsetWidth };
  });
  assert.ok(duringFold.nav > 48 && duringFold.nav < adjusted[0]);
  assert.equal(duringFold.preview, adjusted[2]);
  await page.waitForFunction(() => !document.querySelector('#app-sidebar').hasAttribute('data-folding'));
  await navDivider().waitFor({ state: 'hidden' });
  assert.equal((await widths())[0], 48);
  assert.equal((await widths())[2], adjusted[2]);
  const compactNav = page.locator('#research-sidebar');
  const entriesIcon = compactNav.getByRole('button', { name: '实验记录', exact: true });
  await entriesIcon.hover();
  assert.equal(await entriesIcon.evaluate(el => getComputedStyle(el, '::before').content), '"实验记录"');
  assert.equal(await entriesIcon.getAttribute('aria-current'), 'page');
  assert.ok(!await entriesIcon.locator('span').isVisible());
  await compactNav.getByRole('button', { name: '研究阶段', exact: true }).press('Enter');
  await navDivider().waitFor();
  assert.deepEqual(await widths(), adjusted);
  assert.ok(await compactNav.evaluate(nav => nav.contains(document.activeElement)));
  await sizeWindow(740);
  await page.waitForFunction(() => document.querySelector('#research-workspace').inert);
  assert.equal(await listDivider().count(), 0);
  assert.equal(await page.locator('.research-reader-scrim').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  assert.equal(await page.locator('#document-surface').evaluate(el => getComputedStyle(el).boxShadow), 'none');
  await sizeWindow(1280);
  await listDivider().waitFor();
  assert.deepEqual(await widths(), adjusted);
  await closeReader();
  assert.equal(await navDivider().getAttribute('aria-valuenow'), String(adjusted[0]));
  await app.close();
  app = undefined;
  await launch();
  await sizeWindow(1280);
  await openColumns();
  assert.deepEqual(await widths(), adjusted);
  await listDivider().press('Home');
  assert.equal(await listDivider().getAttribute('aria-valuenow'), await listDivider().getAttribute('aria-valuemin'));
  await listDivider().press('End');
  assert.equal(await listDivider().getAttribute('aria-valuenow'), await listDivider().getAttribute('aria-valuemax'));
  await navDivider().press('Enter');
  await listDivider().dblclick();
  assert.deepEqual(await widths(), [nav, list, preview]);
  pass('both research dividers resize adjacent columns, support keyboard and cancel, and restore widths after resize and restart');
  pass('paper texture remains in the reading margins with flat dividers in split and overlay views');
  await closeReader();
  const projectNav = page.locator('#research-sidebar');
  await projectNav.getByRole('region', { name: '项目页面' }).getByRole('button', { name: '时间线' }).click();
  const phaseLink = id => projectNav.locator(`[data-research-stage-link="${id}"]`);
  const endedShelf = projectNav.locator('[data-research-phase-group=ended]');
  if (!await endedShelf.evaluate(shelf => shelf.open)) await endedShelf.locator('summary').click();
  await phaseLink('validation').click();
  await idle();
  await page.locator('.research-entry-title [data-research-record=forest-validation]:visible, [data-research-stage-record=forest-validation]:visible').click();
  await page.locator('#research-reader-title').getByText('树林轨迹复测').waitFor();
  await projectNav.locator('[data-research-stage-record=forest-validation][aria-current=page]').waitFor();
  assert.equal(await page.locator('#research-workspace').isVisible(), false);
  assert.equal(await listDivider().count(), 0);
  const sibling = projectNav.locator('[data-research-stage-record]:not([data-research-stage-record=forest-validation])').first();
  const siblingTitle = await sibling.innerText();
  await sibling.click();
  await page.locator('#research-reader-title').getByText(siblingTitle, { exact: true }).waitFor();
  await projectNav.locator('[data-research-stage-record=forest-validation]').click();
  await page.locator('#research-reader-title').getByText('树林轨迹复测').waitFor();
  await phaseLink('baseline').click();
  await projectNav.locator('[data-research-stage-link=baseline][aria-current=location]').waitFor();
  await phaseLink('validation').click();
  await page.locator('#research-reader-title').getByText('树林轨迹复测').waitFor();
  assert.equal(await phaseLink('validation').getAttribute('aria-current'), 'location');
  assert.equal(await page.locator('.research-breadcrumb span').last().innerText(), '复测与验证');
  const timingLink = page.locator('#research-reader-related [data-research-related=forest-timings]');
  await showReaderReferences();
  const stageInspector = page.locator('#research-evidence-inspector');
  await timingLink.click();
  await stageInspector.getByRole('table').waitFor();
  const tableScroll = stageInspector.locator('.research-table-scroll');
  assert.ok(await tableScroll.evaluate(node => node.scrollWidth > node.clientWidth));
  await stageInspector.getByRole('button', { name: '固定到右栏' }).click();
  const horizontal = await tableScroll.evaluate(node => { node.scrollLeft = 68; return node.scrollLeft; });
  assert.ok(horizontal > 0);
  await page.locator('#research-reader-related [data-research-related=forest-manifest]').click();
  await stageInspector.locator('pre').waitFor();
  await stageInspector.getByRole('tab', { name: /逐视角 CPU 计时表/ }).click();
  assert.equal(await tableScroll.evaluate(node => node.scrollLeft), horizontal);
  await stageInspector.getByRole('button', { name: '展开证据预览' }).click();
  assert.ok(await tableScroll.evaluate(node => node.scrollWidth === node.clientWidth));
  await stageInspector.getByRole('button', { name: '恢复并排阅读' }).click();
  assert.ok(await page.locator('#editor-workspace').isVisible());
  await sizeWindow(520);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#editor-workspace')).visibility === 'hidden');
  await page.keyboard.press('Escape');
  await stageInspector.waitFor({ state: 'hidden' });
  assert.ok(await timingLink.evaluate(link => document.activeElement === link));
  await page.locator('#research-reader-title').getByText('树林轨迹复测').waitFor();
  pass('stage navigation resumes the last record and narrow evidence returns to its link');
  assert.deepEqual(errors, []);

  await fs.writeFile(path.join(folder, 'results.json'), JSON.stringify({ results, errors }, null, 2) + '\n');
  console.log(`Timeline screenshot: ${path.join(folder, 'timeline.png')}`);
} finally {
  if (app) {
    await app.evaluate(({ app, BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.quit(); }).catch(() => {});
    await app.close().catch(() => {});
  }
}

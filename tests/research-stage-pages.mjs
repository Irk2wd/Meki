import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkStagePages({ page, command, open, closeReader, archive, image }) {
  const types = { entry: '实验', summary: '总结', comparison: '可视化', event: '组会' };
  const phaseId = 'canopy';
  const phaseTitle = '树冠精度';
  command('init', [], {
    version: 1, id: 'stage-archive', title: '阶段分页验证', timezone: 'Asia/Shanghai',
    phases: [{ id: phaseId, title: phaseTitle, start: '2026-11-01' }, { id: 'control', title: '对照', start: '2026-11-01' }],
    recordTypes: Object.entries(types).map(([kind, label]) => ({ id: kind, kind, label, template: '', fields: [] })),
    views: [{ id: 'timeline', label: '时间线', layout: 'timeline', order: 'newest' }], defaultView: 'timeline',
  });
  command('bind-source', ['figures', '--path', archive, '--label', '图像']);
  const imagePath = path.relative(archive, image).split(path.sep).join('/');
  command('index', ['canopy-frame', '--source', 'figures', '--path', imagePath]);
  for (const [kind, count] of Object.entries({ entry: 82, summary: 24, comparison: 13, event: 12 })) {
    command('batch', [], { records: Array.from({ length: count }, (_, i) => {
      const number = String(i + 1).padStart(2, '0');
      const date = kind === 'summary' ? '2026-11-19' : i === 0 ? '2026-11-17' : '2026-11-18';
      return { id: `${kind}-${number}`, type: kind, title: `${types[kind]} ${number}`, date, phaseId, body: `第 ${number} 轮的树冠观测。`,
        ...(kind === 'summary' && { coverage: { start: date, end: date } }),
        ...(kind === 'comparison' && { comparison: { columns: ['树冠'], rows: [{ label: '近景', images: ['canopy-frame'] }] } }),
      };
    }) });
  }
  await open();
  const phase = page.locator(`[data-research-phase="${phaseId}"]`);
  await phase.click();
  const list = kind => page.locator(`[data-stage-list="${kind}"]`);
  const rows = kind => list(kind).locator('li [data-research-record]');
  const turn = (kind, name) => list(kind).getByRole('button', { name, exact: true }).click();
  const size = (kind, value) => list(kind).getByRole('combobox').selectOption(value);
  const current = kind => list(kind).locator('[aria-current=page]').innerText();
  async function checkOnlyPage(kind) {
    const nav = list(kind).getByRole('navigation');
    assert.equal(await nav.getByRole('button').count(), 3);
    const onlyPage = nav.getByRole('button', { name: '第 1 页', exact: true });
    assert.ok(await onlyPage.isVisible());
    assert.equal(await onlyPage.getAttribute('aria-current'), 'page');
    assert.ok(await nav.getByRole('button', { name: '上一页', exact: true }).isDisabled());
    assert.ok(await nav.getByRole('button', { name: '下一页', exact: true }).isDisabled());
  }
  for (const kind of Object.keys(types)) {
    assert.equal(await rows(kind).count(), 10);
    assert.equal(await list(kind).getByRole('combobox').inputValue(), '10');
    assert.ok(await list(kind).getByRole('button', { name: '上一页' }).isDisabled());
  }
  assert.equal(await list('entry').getByText('…', { exact: true }).count(), 1);
  await turn('entry', '第 9 页');
  assert.equal(await rows('entry').count(), 2);
  assert.ok(await list('entry').getByRole('button', { name: '下一页' }).isDisabled());
  assert.ok(await page.locator('#research-experiments-title').evaluate(el => el === document.activeElement));
  await turn('summary', '下一页');
  await turn('event', '下一页');
  await turn('comparison', '下一页');
  assert.equal(await rows('event').count(), 2);
  assert.equal(await rows('comparison').count(), 3);
  await list('comparison').locator('.research-sample-image img').first().waitFor();
  assert.equal(await current('summary'), '2');
  assert.equal(await current('entry'), '9');

  for (const [value, count] of [['20', 20], ['50', 50], ['all', 82], ['10', 10]]) {
    await size('entry', value);
    assert.equal(await rows('entry').count(), count);
    assert.equal(await current('summary'), '2');
    assert.equal(await list('summary').getByRole('combobox').inputValue(), '10');
  }
  await size('summary', '20');
  await turn('summary', '下一页');
  assert.equal(await rows('summary').count(), 3);
  assert.equal(await page.locator('.research-progress-latest [data-research-record]').getAttribute('data-research-record'), 'summary-24');
  await turn('entry', '第 2 页');
  const last = rows('entry').last();
  assert.equal(await last.getAttribute('data-research-record'), 'entry-63');
  await last.scrollIntoViewIfNeeded();
  const scroll = await page.locator('.research-content').evaluate(el => el.scrollTop);
  await last.click();
  await page.locator('#research-reader-title').getByText('实验 63', { exact: true }).waitFor();
  await page.locator('[data-peek-step="1"]').click();
  await page.locator('#research-reader-title').getByText('实验 62', { exact: true }).waitFor();
  await closeReader();
  assert.equal(await current('entry'), '2');
  assert.equal(await page.locator('.research-content').evaluate(el => el.scrollTop), scroll);
  await page.locator('#research-date').fill('2026-11-17');
  assert.equal(await rows('entry').count(), 1);
  await checkOnlyPage('entry');
  assert.equal(await rows('entry').first().getAttribute('data-research-record'), 'entry-01');
  assert.equal(await current('summary'), '2');
  await page.locator('#research-date').fill('');
  await turn('entry', '第 9 页');
  command('batch', [], { records: ['entry-82', 'entry-81'].map(id => ({ id, ifRevision: command('read', [id]).revision, phaseId: 'control' })) });
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await list('entry').getByText('第 71–80 条，共 80 条', { exact: true }).waitFor();
  assert.equal(await current('entry'), '8');
  assert.equal(await current('summary'), '2');
  await page.locator('[data-research-phase=control]').click();
  assert.equal(await rows('entry').count(), 2);
  await checkOnlyPage('entry');
  await phase.click();
  assert.equal(await current('entry'), '8');
  assert.equal(await current('summary'), '2');
  for (const kind of Object.keys(types)) {
    await size(kind, 'all');
    await checkOnlyPage(kind);
  }
}

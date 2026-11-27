import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const { FileStore } = require('../electron/file-store.cjs');
const { createExampleProject } = require('../electron/research-example.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mekir-search-smoke-')));
process.env.MEKIR_LOCAL_STATE = path.join(tmp, 'bindings');
const project = path.join(tmp, 'render-research');
const profile = path.join(tmp, 'profile');
let app;
try {
  const example = await createExampleProject(project);
  const comparison = await example.read('tile-culling');
  await example.writeBatch({ records: [{ id: 'tile-culling', ifRevision: comparison.revision,
    body: comparison.body + '\n用[回放轨迹][轨迹]核对树叶遮挡。\n\n[轨迹]: mekir:forest-validation\n' }] });
  const store = new FileStore(profile);
  await store.init();
  await store.changeRecentFolders('remember', project);
  const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.MEKIR_TEST_CONCEPT) env.MEKIR_SEARCH_HOME = path.join(tmp, 'search');
  app = await electron.launch({ executablePath: env.MEKI_EXECUTABLE || require('electron'), args: env.MEKI_EXECUTABLE ? [] : [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  if (env.MEKIR_TEST_DEBUG) {
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => process.stderr.write(data));
    page.on('console', message => console.error(message.type(), message.text()));
  }
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.waitForSelector('#shell[data-ready="true"]');
  const search = page.locator('#research-search-dialog');
  const queryInput = search.getByRole('searchbox');
  const formatFilter = search.getByRole('combobox', { name: '资料类型', exact: true });
  await page.locator('[data-research-search]').click();
  await queryInput.click();
  assert.equal(await queryInput.evaluate(input => getComputedStyle(input).outlineStyle), 'none');
  await page.keyboard.press('Tab');
  assert.ok(await search.locator('button[type=submit]').evaluate(button =>
    button.matches(':focus-visible') && getComputedStyle(button).outlineStyle !== 'none'));
  await page.keyboard.press('Shift+Tab');
  assert.ok(await queryInput.evaluate(input => input === document.activeElement));
  await formatFilter.press('Space');
  await formatFilter.locator('option:checked').waitFor({ state: 'visible' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  assert.ok(await search.isVisible());
  assert.equal(await formatFilter.inputValue(), 'all');
  assert.ok(await formatFilter.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle === 'none'));
  await formatFilter.press('Space');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await formatFilter.inputValue(), 'file');
  await page.keyboard.press('Escape');

  async function find(query, format, mode = 'keyword') {
    await page.locator('[data-research-search]').click();
    await queryInput.fill(query);
    await formatFilter.click();
    await formatFilter.locator(`option[value="${format}"]`).click();
    await search.locator('label:has(input[value='+mode+'])').click();
    await search.locator('button[type=submit]').click();
    await search.locator('.research-search-results:not([aria-busy]) article').first().waitFor({ timeout: 120000 });
    assert.doesNotMatch(await search.locator('[role=status]').innerText(), /暂时无法索引|不可用|unavailable/i);
  }
  async function closeReader() {
    await page.waitForFunction(() => !document.body.classList.contains('is-busy'));
    await page.locator('[data-action=research-close-reader]').click();
    await page.locator('#document-surface').waitFor({ state: 'hidden' });
  }
  const hit = id => search.locator('[data-search-document="'+id+'"] [data-hit-index="0"]');
  await find('逐帧核对遮挡边缘', 'markdown');
  await hit('tile-culling').click();
  const marked = page.locator('#visual-editor [data-research-search-target]');
  await marked.waitFor();
  assert.match(await marked.innerText(), /逐帧核对遮挡边缘/);
  await closeReader();
  await find('baseline-repeat', 'markdown');
  await hit('tile-culling').click();
  await marked.filter({ hasText: 'baseline-repeat' }).waitFor();
  assert.match(await marked.innerText(), /baseline-repeat/);
  assert.equal(await marked.evaluate(node => node.tagName), 'TR');
  await closeReader();
  await find('回放轨迹', 'markdown');
  await hit('tile-culling').click();
  await marked.filter({ hasText: '用回放轨迹核对树叶遮挡。' }).waitFor();
  await closeReader();
  console.log('PASS open the matching paragraph, trial row and formatted Markdown passage in the reader');
  const report = page.locator('#research-report-dialog');
  async function tablePage(format, id, expected, query = '不同机位的计时对比', mode = 'keyword') {
    await find(query, format, mode);
    const result = hit(id);
    assert.match(await result.innerText(), new RegExp('第 '+expected+' 页 · 数据表'));
    await result.click();
    await report.locator('.research-report-stage[aria-busy=false] #research-report-status[hidden]').waitFor({ state: 'attached' });
    assert.match(await report.locator('#research-report-page').innerText(), new RegExp('第 '+expected+' 页'));
    await report.locator('[data-report-prev]').click();
    assert.match(await report.locator('#research-report-page').innerText(), new RegExp('第 '+(expected-1)+' 页'));
    await report.locator('[data-report-close]').click();
  }
  await tablePage('pptx', 'forest-slides', 3);
  await tablePage('pdf', 'forest-observations', 2);
  console.log('PASS timing searches rank the data table first and open the actual slide and PDF page');
  if (env.MEKIR_TEST_CONCEPT) {
    await tablePage('pptx', 'forest-slides', 3, '哪一页比较了从不同位置绘制树林要花的时间？', 'concept');
    console.log('PASS concept search opens the timing table using a natural-language paraphrase');
  }
  assert.deepEqual(errors, []);
} finally {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { zipEntries } = require('../electron/docx-template.cjs');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'export-presets-')));
const profile = path.join(run, 'profile'), temporary = path.join(run, 'temp'), documentPath = path.join(run, 'chapters.md');
const indexPath = path.join(profile, 'export-presets-v1', 'index.json');
const fixture = '# First chapter\n\nFirst chapter body remains in the export.\n\n# Second chapter\n\nSecond chapter body remains in the export.\n';
await fs.mkdir(temporary); await fs.writeFile(documentPath, fixture);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_OPEN_PATH: documentPath, MEKI_TEST_DISCARD: 'discard', TEMP: temporary, TMP: temporary };
delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = [], skipped = [], tracked = new Set(); let app, page;
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function poll(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(`Timed out: ${message}`);
}
async function ready(target) {
  target.setDefaultTimeout(20000);
  if (!tracked.has(target)) { tracked.add(target); target.on('pageerror', error => errors.push(error.message)); }
  await target.waitForSelector('#shell[data-ready="true"]'); return target;
}
async function launch() {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? [] : [root], env, timeout: 30000 });
  page = await ready(await app.firstWindow());
  await (await app.browserWindow(page)).evaluate(win => { win.show(); win.focus(); });
  if (!(await page.locator('.ProseMirror').innerText()).includes('First chapter body')) {
    await action(page, 'open'); await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('First chapter body'));
  }
  return page;
}
async function stop() {
  if (!app) return;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null;
}
async function setting(name, value) { await app.evaluate((_electron, { name, value }) => { process.env[name] = value; }, { name, value }); }
async function action(target, name) {
  await target.waitForFunction(() => !document.body.classList.contains('is-busy'));
  await target.locator(`[data-action="${name}"]`).first().evaluate(node => node.click());
}
async function catalog(target = page) { return target.evaluate(() => window.meki.listExportPresets()); }
async function diskCatalog() { return JSON.parse(await fs.readFile(indexPath, 'utf8')); }
async function openDialog(target = page, broken = false) {
  await action(target, 'export-options'); await target.locator('#export-dialog').waitFor({ state: 'visible' });
  if (!broken) {
    const expected = await catalog(target);
    await target.waitForFunction(({ presets, templates }) => {
      const values = id => [...document.querySelector(id).options].map(option => option.value).filter(Boolean).sort();
      return JSON.stringify(values('#export-preset')) === JSON.stringify(presets.map(item => item.id).sort()) && JSON.stringify(values('#word-reference')) === JSON.stringify(templates.map(item => item.id).sort());
    }, expected);
  }
}
async function closeDialog(target = page) { await target.locator('#export-dialog [aria-label="关闭导出设置"]').click(); await target.locator('#export-dialog').waitFor({ state: 'hidden' }); }
async function button(id, target = page) {
  await target.locator(`#${id}`).click();
  await target.waitForFunction(id => !document.querySelector(`#${id}`).disabled, id);
}
async function savePreset(name, { asNew = false, target = page } = {}) {
  await target.locator('#export-preset-name').fill(name); await button(asNew ? 'save-as-export-preset' : 'save-export-preset', target);
  assert.match(await target.locator('#export-feedback').innerText(), /已保存导出预设/);
  const id = await target.locator('#export-preset').inputValue();
  const saved = (await catalog(target)).presets.find(item => item.id === id); assert.equal(saved?.name, name); return saved;
}
async function selectPreset(id, target = page) {
  await target.locator('#export-preset').selectOption(id);
  await target.waitForFunction(() => !document.querySelector('#save-export-preset').disabled);
}
async function exportFile(kind, name, configure = async () => {}, { alreadyOpen = false } = {}) {
  const file = path.join(run, name); await setting(`MEKI_TEST_EXPORT_${kind.replace('-', '_').toUpperCase()}_PATH`, file);
  if (!alreadyOpen) await openDialog();
  await page.locator('#export-kind').selectOption(kind); await configure();
  await page.locator('#confirm-export').click(); await page.locator('#export-dialog').waitFor({ state: 'hidden' });
  await poll(async () => (await fs.stat(file).catch(() => null))?.size > 100, `export ${name}`, 60000);
  await page.waitForFunction(name => !document.body.classList.contains('is-busy') && document.querySelector('#toast')?.textContent.includes(name), name, { timeout: 60000 });
  return file;
}
async function editorAppearance() {
  return page.evaluate(async () => ({ theme: document.documentElement.dataset.theme, size: getComputedStyle(document.querySelector('.ProseMirror')).fontSize, paragraph: getComputedStyle(document.querySelector('.ProseMirror p')).fontSize, settings: (await window.meki.boot()).settings }));
}
async function renderedHtml(file) {
  return app.evaluate(async ({ BrowserWindow }, file) => {
    const viewer = new BrowserWindow({ show: false, webPreferences: { partition: `meki-test-export-${Date.now()}`, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    try {
      await viewer.loadFile(file);
      return await viewer.webContents.executeJavaScript(`({ body: getComputedStyle(document.body).backgroundColor, article: getComputedStyle(document.querySelector('.meki-document')).fontSize, paragraph: getComputedStyle(document.querySelector('.meki-document p')).fontSize, text: document.body.textContent })`);
    } finally { viewer.destroy(); }
  }, file);
}
function pdfPages(bytes) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const objects = new Map([...bytes.toString('latin1').matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)].map(match => [match[1], match[2]]));
  const pages = [...objects.values()].filter(value => /\/Type\s*\/Page\b/.test(value));
  assert.ok(pages.length, 'Chromium PDF exposes page objects');
  for (const value of pages) {
    const contents = value.match(/\/Contents\s+(\d+)\s+0\s+R/); assert.ok(contents, 'page has a content stream');
    const object = objects.get(contents[1]), stream = object?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/); assert.ok(stream, 'page content exists');
    const data = Buffer.from(stream[1], 'latin1'), decoded = /\/FlateDecode/.test(object) ? inflateSync(data).toString('latin1') : data.toString('latin1');
    assert.match(decoded, /<[\da-f]+>\s*Tj|\([^)]*[^()\s][^)]*\)\s*Tj|\[[^\]]+\]\s*TJ/i, 'every page, including the first, contains drawn text');
  }
  return pages.length;
}
async function makeReference(executable, output) {
  await new Promise((resolve, reject) => {
    const child = execFile(executable, ['--sandbox', '--from=markdown', '--to=docx', `--output=${output}`], { windowsHide: true, timeout: 30000, env }, error => error ? reject(error) : resolve());
    child.stdin.end('# TEMPLATE BODY MUST NOT APPEAR\n\nPrivate sample template text.\n');
  });
  const entries = zipEntries(await fs.readFile(output));
  entries.set('word/styles.xml', Buffer.from(entries.get('word/styles.xml').toString().replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="MekiReferenceProof"><w:name w:val="Meki Reference Proof"/><w:rPr><w:color w:val="B24F98"/></w:rPr></w:style></w:styles>')));
  const archive = new (require('yazl').ZipFile)(), chunks = [];
  const completed = new Promise((resolve, reject) => { archive.outputStream.on('data', chunk => chunks.push(chunk)); archive.outputStream.on('error', reject); archive.outputStream.on('end', () => resolve(Buffer.concat(chunks))); });
  for (const [name, bytes] of entries) archive.addBuffer(bytes, name);
  archive.end(); await fs.writeFile(output, await completed);
}

try {
  await launch(); await openDialog();
  await page.locator('#pdf-paper').selectOption('A4'); await page.locator('#pdf-margin').fill('18');
  await page.locator('#pdf-heading-break').check(); await page.locator('#export-theme').selectOption('linen'); await page.locator('#export-font-size').fill('28');
  const first = await savePreset('A4 report');
  assert.equal(first.options.pdf.pageBreakBeforeH1, true); assert.equal(first.options.theme, 'linen'); assert.equal(first.options.fontSize, 28);
  assert.equal((await diskCatalog()).presets[0].id, first.id);
  pass('named presets persist page settings, heading pagination, export theme and font size');

  await page.locator('#pdf-margin').fill('20'); const updated = await savePreset('A4 report updated');
  assert.equal(updated.id, first.id); assert.equal(updated.options.pdf.margin, 20); assert.equal((await catalog()).presets.length, 1);
  await page.locator('#pdf-paper').selectOption('Letter'); await page.locator('#pdf-orientation').selectOption('landscape');
  const duplicate = await savePreset('Letter copy', { asNew: true });
  assert.notEqual(duplicate.id, first.id); assert.equal((await catalog()).presets.length, 2);
  assert.equal((await catalog()).presets.find(item => item.id === first.id).options.pdf.pageSize, 'A4');
  pass('saving updates the selected identity; Save As creates an independent preset');

  await button('delete-export-preset'); assert.match(await page.locator('#export-feedback').innerText(), /已删除预设/);
  assert.equal((await catalog()).presets.length, 1); assert.equal(await page.locator('#export-preset').inputValue(), '');
  assert.equal(await page.locator('#pdf-paper').inputValue(), 'Letter'); await closeDialog();
  pass('deleting a preset removes only its saved record and keeps the current export options');

  const created = app.waitForEvent('window'); await page.locator('[data-action="window-menu"]').click(); await page.locator('#window-panel [data-action="new-window"]').click();
  const second = await ready(await created); await openDialog(second); await selectPreset(first.id, second);
  assert.equal(await second.locator('#export-preset-name').inputValue(), 'A4 report updated'); assert.equal(await second.locator('#pdf-paper').inputValue(), 'A4');
  assert.equal(await second.locator('#pdf-heading-break').isChecked(), true); assert.equal(await second.locator('#export-font-size').inputValue(), '28');
  await second.locator('#export-font-size').fill('30'); await savePreset('Updated in second window', { target: second }); await closeDialog(second);
  await openDialog(); await selectPreset(first.id); assert.equal(await page.locator('#export-font-size').inputValue(), '30'); await closeDialog();
  await (await app.browserWindow(second)).evaluate(win => win.close()); await poll(() => Promise.resolve(app.windows().length === 1), 'second window closes');
  pass('another native window reads shared presets and its updates are visible after reopening the dialog');

  const beforeRestart = await diskCatalog(); await stop(); await launch(); await openDialog(); await selectPreset(first.id);
  assert.equal(await page.locator('#export-preset-name').inputValue(), 'Updated in second window'); assert.equal(await page.locator('#export-font-size').inputValue(), '30');
  assert.deepEqual(await diskCatalog(), beforeRestart); await closeDialog();
  pass('presets retain their identity and complete settings across an application restart');

  const appearance = await editorAppearance();
  const html = await exportFile('html', 'night-28px.html', async () => { await page.locator('#export-theme').selectOption('night'); await page.locator('#export-font-size').fill('28'); });
  const rendered = await renderedHtml(html); assert.equal(rendered.body, 'rgb(32, 37, 33)'); assert.equal(rendered.article, '28px'); assert.equal(rendered.paragraph, '28px'); assert.match(rendered.text, /First chapter body/);
  assert.deepEqual(await editorAppearance(), appearance); assert.equal(await fs.readFile(documentPath, 'utf8'), fixture);
  pass('actual HTML renders its selected night theme and 28 px text without changing editor settings or Markdown');

  const configurePdf = async enabled => {
    await page.locator('#pdf-paper').selectOption('A4'); await page.locator('#pdf-orientation').selectOption('portrait'); await page.locator('#pdf-margin').fill('19');
    await page.locator('#pdf-pages').uncheck(); await page.locator('#pdf-header').uncheck(); await page.locator('#pdf-heading-break').setChecked(enabled);
    await page.locator('#export-theme').selectOption('paper'); await page.locator('#export-font-size').fill('18');
  };
  const continuous = await exportFile('pdf', 'continuous.pdf', () => configurePdf(false)); assert.equal(pdfPages(await fs.readFile(continuous)), 1);
  const split = await exportFile('pdf', 'chapters.pdf', () => configurePdf(true)); assert.equal(pdfPages(await fs.readFile(split)), 2);
  assert.deepEqual(await editorAppearance(), appearance);
  pass('two short H1 chapters stay on one PDF page by default and become exactly two nonblank pages when enabled');

  const tools = await page.evaluate(() => window.meki.exportTools());
  if (process.env.MEKI_REQUIRE_PANDOC === '1' || process.env.CI === 'true') assert.equal(tools.available, true, `Actual Pandoc required: ${tools.message}`);
  if (tools.available) {
    const reference = path.join(run, 'personal-reference.docx'); await makeReference(tools.path, reference); const referenceBytes = await fs.readFile(reference);
    await setting('MEKI_TEST_REFERENCE_PATH', reference); await openDialog(); await page.locator('#export-kind').selectOption('docx'); await button('choose-word-reference');
    assert.match(await page.locator('#export-feedback').innerText(), /已保存模板副本/);
    const referenceId = await page.locator('#word-reference').inputValue(), savedReference = (await catalog()).templates.find(item => item.id === referenceId);
    assert.equal(savedReference?.name, 'personal-reference.docx');
    const copy = path.join(profile, 'export-presets-v1', 'templates', `${referenceId}.docx`);
    assert.deepEqual(await fs.readFile(copy), referenceBytes); assert.deepEqual(await fs.readFile(reference), referenceBytes);
    await setting('MEKI_TEST_REFERENCE_PATH', ''); await button('choose-word-reference');
    assert.equal(await page.locator('#word-reference').inputValue(), referenceId); assert.equal((await catalog()).templates.length, 1);
    pass('the native Word template picker stores a controlled copy; cancel preserves the selected template');

    const wordPreset = await savePreset('Word with personal template'); assert.equal(wordPreset.options.referenceId, referenceId);
    await button('delete-word-reference'); assert.match(await page.locator('#export-feedback').innerText(), /仍被导出预设使用/); assert.ok(await fs.stat(copy));
    assert.equal((await catalog()).templates.length, 1); await closeDialog();
    await openDialog(); assert.equal(await page.locator('#export-kind').inputValue(), 'docx');
    assert.equal(await page.locator('#export-preset').inputValue(), wordPreset.id); await closeDialog();
    pass('a template referenced by a saved preset cannot be deleted');

    await fs.unlink(reference); await stop(); await launch(); await openDialog(); await selectPreset(wordPreset.id);
    assert.equal(await page.locator('#word-reference').inputValue(), referenceId);
    const word = await exportFile('docx', 'template-export.docx', async () => {}, { alreadyOpen: true });
    const contents = zipEntries(await fs.readFile(word)), body = contents.get('word/document.xml').toString(), styles = contents.get('word/styles.xml').toString();
    assert.match(body, /First chapter body/); assert.match(body, /Second chapter body/); assert.doesNotMatch(body, /TEMPLATE BODY MUST NOT APPEAR|Private sample template text/);
    assert.match(styles, /MekiReferenceProof/); assert.match(styles, /B24F98/); assert.deepEqual(await fs.readFile(copy), referenceBytes);
    pass('after source deletion and restart, the template copy supplies Word styles without inserting its sample body');

    await openDialog(); await selectPreset(wordPreset.id); await button('delete-export-preset'); await page.locator('#word-reference').selectOption(referenceId); await button('delete-word-reference');
    assert.match(await page.locator('#export-feedback').innerText(), /已删除应用内模板副本/); assert.equal((await catalog()).templates.length, 0);
    await assert.rejects(fs.stat(copy), { code: 'ENOENT' }); await closeDialog();
    pass('removing the referencing preset allows its unused template copy to be deleted');
  } else { skipped.push(`Word template integration: ${tools.message}`); console.log(`SKIP ${skipped.at(-1)}`); }

  await stop(); const damaged = '{damaged-export-presets'; await fs.writeFile(indexPath, damaged); await launch();
  await openDialog(page, true); await page.waitForFunction(() => document.querySelector('#export-feedback')?.textContent.includes('原数据已保留'));
  assert.doesNotMatch(await page.locator('#export-feedback').innerText(), /invoking remote method|meki:list/);
  assert.match(await page.locator('.ProseMirror').innerText(), /First chapter body/);
  const basic = await exportFile('html', 'without-presets.html', async () => { await page.locator('#export-theme').selectOption('current'); await page.locator('#export-font-size').fill(''); }, { alreadyOpen: true });
  assert.match(await fs.readFile(basic, 'utf8'), /First chapter body/); assert.equal(await fs.readFile(indexPath, 'utf8'), damaged);
  pass('a corrupt preset index reports a recoverable error while startup, editing and basic HTML export remain available');
  if (tools.available) {
    await openDialog(page, true); await page.waitForFunction(() => document.querySelector('#export-feedback')?.textContent.includes('原数据已保留'));
    const basicWord = await exportFile('docx', 'without-template.docx', async () => { await page.locator('#word-reference').selectOption(''); }, { alreadyOpen: true });
    assert.match(zipEntries(await fs.readFile(basicWord)).get('word/document.xml').toString(), /First chapter body/); assert.equal(await fs.readFile(indexPath, 'utf8'), damaged);
    pass('basic Word export also works with a damaged preset index when no template is selected');
  }
  assert.deepEqual(errors, []); assert.equal(await fs.readFile(documentPath, 'utf8'), fixture);
  pass('the complete workflow produces no renderer exceptions and preserves source document bytes');
} finally {
  if (app && page) {
    await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {});
    await fs.writeFile(path.join(run, 'last-state.json'), JSON.stringify(await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, feedback: document.querySelector('#export-feedback')?.textContent, busy: document.body.classList.contains('is-busy'), dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.id) })).catch(() => null), null, 2));
  }
  await stop(); await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, skipped }, null, 2)); console.log(`Evidence: ${run}`);
}

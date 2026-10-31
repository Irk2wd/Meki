import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const run = path.join(root, 'test-results', `headings-${Date.now()}`); await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '章节.md'), htmlPath = path.join(run, 'headings.html'), pdfPath = path.join(run, 'headings.pdf');
const original = '\uFEFF' + ['---', 'title: 保持原文', '---', '', '[TOC]', '', '### Opening', '', 'Text one.', '', '###### Deep', '', 'Text two.', '', '### Opening', '', 'Text three.', '', '#', '', 'Empty title.', '', '## Last', '', 'Final paragraph.', ''].join('\r\n');
await fs.writeFile(documentPath, original);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_OPEN_PATH: documentPath, MOYE_TEST_EXPORT_HTML_PATH: htmlPath, MOYE_TEST_EXPORT_PDF_PATH: pdfPath, MOYE_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const expected = ['1', '1.1', '2', '3', '3.1'], labels = ['1 Opening', '1.1 Deep', '2 Opening', '3 未命名标题', '3.1 Last'];
const results = [], errors = []; let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
const headings = target => target.locator('.moye-document h1,.moye-document h2,.moye-document h3,.moye-document h4,.moye-document h5,.moye-document h6');
async function launch() {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', documentPath] : [root, '--open', documentPath], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.stack || error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function toggle() { await page.locator('#format-menu-button').click(); await page.locator('[data-edit-command="heading-numbering"]').click(); }
async function numbers(target = page) { return headings(target).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-heading-number'))); }
async function ids(target = page) { return headings(target).evaluateAll(nodes => nodes.map(node => node.id)); }
async function sourceFill(value) { await page.locator('[data-mode="source"]').click(); await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(value); await page.locator('[data-mode="visual"]').click(); }
try {
  await launch(); assert.deepEqual(await numbers(), [null, null, null, null, null]); const anchors = await ids();
  await toggle(); assert.deepEqual(await numbers(), expected); assert.deepEqual(await ids(), anchors);
  assert.deepEqual(await page.locator('.moye-toc a').allTextContents(), labels);
  assert.deepEqual(await page.locator('[data-outline-index]').allTextContents(), labels);
  assert.deepEqual(await headings(page).evaluateAll(nodes => nodes.map(node => getComputedStyle(node, '::before').content)), expected.map(number => `"${number} "`));
  assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  await action('save'); assert.equal(await fs.readFile(documentPath, 'utf8'), original);
  await page.locator('[data-mode="source"]').click(); await page.locator('[data-mode="visual"]').click(); await action('save'); assert.equal(await fs.readFile(documentPath, 'utf8'), original);
  pass('display numbering handles skipped levels, duplicates and empty titles consistently without editing bytes or anchors');

  await toggle(); assert.deepEqual(await numbers(), [null, null, null, null, null]); assert.deepEqual(await ids(), anchors);
  assert.deepEqual(await page.locator('.moye-toc a').allTextContents(), ['Opening', 'Deep', 'Opening', '未命名标题', 'Last']);
  await toggle(); await page.locator('[data-outline-control="collapse"]').click(); await page.locator('[data-outline-control="expand"]').click(); assert.deepEqual(await page.locator('[data-outline-index]').allTextContents(), labels);
  await page.locator('.ProseMirror > p').last().click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'); await page.keyboard.insertText(' Added text.');
  await action('save'); const edited = await fs.readFile(documentPath, 'utf8'); assert.ok(edited.startsWith('\uFEFF---\r\ntitle: 保持原文\r\n---\r\n'));
  assert.ok(edited.includes('Added text.')); assert.ok(!/\r\n#{1,6} [1-3](?:[. ]|$)/m.test(edited)); assert.deepEqual(await ids(), anchors);
  await page.screenshot({ path: path.join(run, 'numbered-document.png') });
  pass('turning numbering off and on preserves anchors, outline folding and ordinary Markdown editing');

  await action('export-html'); const html = await fs.readFile(htmlPath, 'utf8'); assert.ok(html.includes('data-heading-number="1.1"'));
  const windowPromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => { const window = new BrowserWindow({ show: false, webPreferences: { partition: 'headings-export', nodeIntegration: false, contextIsolation: true, sandbox: true } }); await window.loadFile(file); }, htmlPath);
  const exported = await windowPromise; await exported.waitForURL(pathToFileURL(htmlPath).href); await exported.waitForLoadState('load');
  assert.deepEqual(await numbers(exported), expected); assert.deepEqual(await ids(exported), anchors); assert.deepEqual(await exported.locator('.moye-toc a').allTextContents(), labels);
  assert.deepEqual(await headings(exported).evaluateAll(nodes => nodes.map(node => getComputedStyle(node, '::before').content)), expected.map(number => `"${number} "`));
  assert.equal(await exported.locator('.moye-toc a').evaluateAll(links => links.every(link => document.getElementById(link.hash.slice(1)))), true);
  await exported.close(); await page.emulateMedia({ media: 'print' });
  assert.deepEqual(await headings(page).evaluateAll(nodes => nodes.map(node => getComputedStyle(node, '::before').content)), expected.map(number => `"${number} "`));
  await page.emulateMedia({ media: null }); await action('export-pdf'); assert.equal((await fs.readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-');
  pass('standalone HTML and PDF print styling retain the same numbers, TOC labels and original anchors');

  await action('new'); await sourceFill('#### Fresh\n\n###### Child\n\nA new document.'); assert.deepEqual(await numbers(), ['1', '1.1']);
  await sourceFill('[TOC]\n\n# First\n\n## Middle\n\n### Deep\n\n# Second'); assert.deepEqual(await numbers(), ['1', '1.1', '1.1.1', '2']);
  await action('open'); assert.deepEqual(await numbers(), expected); assert.deepEqual(await ids(), anchors);
  pass('new documents and source edits recalculate numbering from one without leaking prior chapter state');

  await exit(); await launch(); assert.equal(await page.locator('[data-edit-command="heading-numbering"]').getAttribute('aria-pressed'), 'true'); assert.deepEqual(await numbers(), expected);
  assert.equal(await page.locator('#dirty-dot').isVisible(), false); await action('save'); assert.equal(await fs.readFile(documentPath, 'utf8'), edited);
  pass('the numbering preference survives restart and reopening remains a byte-preserving view operation');
  assert.deepEqual(errors, []); pass('no renderer exceptions');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally { await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await exit(); console.log(`Evidence: ${run}`); }

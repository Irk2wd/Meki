import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readWindows } from './recovery-fixture.cjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documentEndKey = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const run = path.join(root, 'test-results', `desktop-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '测试文稿.md');
const savePath = path.join(run, '新文稿.md');
const htmlPath = path.join(run, 'export.html');
const pdfPath = path.join(run, 'export.pdf');
const original = '\uFEFF---\r\ntitle: 私人文稿\r\n---\r\n\r\n# 测试文稿\r\n\r\n中文与 Unicode：αβγ。\r\n\r\nInline $E=mc^2$ and $$x+1$$ formula.\r\n\r\n$$\r\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\r\n$$\r\n\r\n- [ ] 待办\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n';
await fs.writeFile(documentPath, original);
await fs.copyFile(path.join(root, 'assets', 'icon.png'), path.join(run, 'test-image.png'));
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_OPEN_PATH: documentPath, MEKI_TEST_SAVE_PATH: savePath, MEKI_TEST_FOLDER_PATH: run, MEKI_TEST_EXPORT_HTML_PATH: htmlPath, MEKI_TEST_EXPORT_PDF_PATH: pdfPath, MEKI_TEST_CONFLICT: 'cancel', MEKI_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const results = [], errors = [];
const record = (name) => { results.push(name); console.log(`PASS ${name}`); };
async function launch(args = []) {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  const page = await app.firstWindow();
  // A real compositor frame is needed for requestAnimationFrame and lazy formula views.
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => document.hasFocus());
  return page;
}
async function idle(page) { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function click(page, action) { await page.locator(`[data-action="${action}"]`).first().click(); await idle(page); }
async function menu(page, action) { await page.locator(`[data-action="${action}"]`).first().evaluate(button => button.click()); await idle(page); }
async function pollFile(file, check) {
  for (let i = 0; i < 100; i++) {
    try { const bytes = await fs.readFile(file); if (check(bytes)) return bytes; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`File assertion timed out: ${file}`);
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
try {
  let page = await launch();
  await page.locator('.ProseMirror h1').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .meki-math mjx-container[jax="SVG"]').length >= 1);
  assert.equal(await page.locator('.ProseMirror .meki-math-error').count(), 0);
  await page.screenshot({ path: path.join(run, 'paper.png'), animations: 'disabled' });
  record('welcome, rich editor and formulas render');
  await click(page, 'style');
  await page.locator('[data-theme="night"]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
  await page.screenshot({ path: path.join(run, 'night.png') });
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.ProseMirror').evaluate(node => getComputedStyle(node).color), 'rgb(217, 223, 213)');
  await page.emulateMedia({ media: 'screen' });
  await page.locator('[data-theme="paper"]').click();
  await page.locator('#font-family').selectOption('sans');
  assert.equal(await page.locator('html').getAttribute('data-font'), 'sans');
  await page.locator('#font-family').selectOption('serif');
  await click(page, 'style');
  record('themes and typography controls');
  await click(page, 'open');
  assert.equal(await page.locator('#document-name').textContent(), path.basename(documentPath));
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .meki-math mjx-container[jax="SVG"]').length >= 3);
  assert.equal(await page.locator('.ProseMirror .meki-math-error').count(), 0);
  const formulaBlock = page.locator('.milkdown-code-block').filter({ has: page.locator('.meki-math mjx-container[jax="SVG"]') }).first();
  assert.equal(await formulaBlock.locator('.codemirror-host').isVisible(), false);
  await formulaBlock.locator('.preview').click();
  assert.equal(await formulaBlock.locator('.codemirror-host').isVisible(), true);
  await page.emulateMedia({ media: 'print' });
  assert.equal(await formulaBlock.locator('.codemirror-host').isVisible(), false);
  assert.equal(await formulaBlock.locator('.preview-label').isVisible(), false);
  assert.equal(await formulaBlock.locator('.meki-math mjx-container[jax="SVG"] svg').isVisible(), true);
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await formulaBlock.locator('.codemirror-host').isVisible(), true);
  await formulaBlock.locator('.preview-toggle-button').click();
  assert.equal(await formulaBlock.locator('.codemirror-host').isVisible(), false);
  record('block formulas show preview and expand to edit on click');
  assert.ok(!(await page.locator('.ProseMirror').innerText()).includes('title:'));
  await page.locator('[data-mode="source"]').click();
  await page.locator('[data-mode="visual"]').click();
  assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  await click(page, 'save');
  assert.equal(await fs.readFile(documentPath, 'utf8'), original);
  record('open/save without edits preserves original BOM and CRLF bytes');
  const inlineFormula = page.locator('.meki-inline-math').first();
  const inlineTooltip = page.locator('.milkdown-latex-inline-edit[data-show="true"]');
  const inlineSource = inlineTooltip.locator('.ProseMirror');
  for (const theme of ['paper', 'linen', 'night']) {
    await click(page, 'style'); await page.locator(`button[data-theme="${theme}"]`).click(); await click(page, 'style');
    await inlineFormula.click(); await inlineSource.waitFor();
    assert.equal(await inlineSource.innerText(), 'E=mc^2');
    const layout = await inlineTooltip.evaluate(tooltip => {
      const input = tooltip.querySelector('.ProseMirror'), bounds = tooltip.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(input);
      const text = range.getBoundingClientRect(), x = (text.left + text.right) / 2, y = (text.top + text.bottom) / 2;
      return { height: bounds.height, textVisible: input.contains(document.elementFromPoint(x, y)) };
    });
    assert.ok(layout.height < 120, `inline formula tooltip must fit its source in ${theme}: ${layout.height}px`);
    assert.ok(layout.textVisible, `inline formula source must be visible in ${theme}`);
    await page.screenshot({ path: path.join(run, `inline-math-${theme}.png`) });
    await page.locator('.editor.ProseMirror h1').click();
  }
  assert.equal(await page.locator('#dirty-dot').isVisible(), false);
  await inlineFormula.click(); await inlineSource.fill('E=mc^3'); await inlineSource.press('Enter');
  await page.waitForFunction(() => document.querySelector('.meki-inline-math')?.dataset.mathTex === 'E=mc^3');
  await page.locator('.editor.ProseMirror h1').click();
  await click(page, 'save');
  await pollFile(documentPath, bytes => bytes.toString().includes('$E=mc^3$'));
  await inlineFormula.click(); assert.equal(await inlineSource.innerText(), 'E=mc^3');
  await page.locator('.editor.ProseMirror h1').click();
  await click(page, 'style'); await page.locator('button[data-theme="paper"]').click(); await click(page, 'style');
  record('inline formula source stays compact and visible in every theme; edits save and reopen');
  await page.locator('[data-mode="source"]').click();
  const source = page.locator('#source-editor .cm-content');
  await source.click(); await page.keyboard.press(documentEndKey);
  await page.keyboard.insertText('\n\n![本地测试图片](test-image.png)\n\n末尾即时保存');
  await click(page, 'save');
  await pollFile(documentPath, b => b.toString().includes('末尾即时保存'));
  record('source edit followed immediately by save');
  await page.locator('[data-mode="visual"]').click();
  const rich = page.locator('.ProseMirror');
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror img')].some(img => img.naturalWidth > 0));
  await click(page, 'find'); await page.locator('#find-query').fill('Unicode');
  await page.waitForFunction(() => document.querySelector('#find-count').textContent === '1 / 1');
  assert.equal(await page.locator('#find-count').textContent(), '1 / 1');
  await click(page, 'find-close');
  await rich.locator(':scope > p').last().click(); await page.keyboard.press(documentEndKey);
  await page.keyboard.insertText('视觉尾字');
  await click(page, 'save');
  await pollFile(documentPath, b => b.toString().includes('视觉尾字'));
  assert.ok((await fs.readFile(documentPath, 'utf8')).startsWith('\uFEFF---\r\ntitle: 私人文稿\r\n---\r\n'));
  record('rich edit immediately saved, metadata retained');
  await click(page, 'math');
  await page.locator('#math-input').fill('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}');
  await page.locator('#math-preview .meki-math mjx-container[jax="SVG"] svg').waitFor();
  assert.equal(await page.locator('#math-preview .meki-math-error').count(), 0);
  await click(page, 'insert-math'); await click(page, 'save');
  await pollFile(documentPath, b => b.toString().includes('\\sum_{i=1}^{n}'));
  record('formula dialog inserts editable TeX');
  await menu(page, 'export-html');
  const html = (await pollFile(htmlPath, b => b.length > 1000)).toString();
  const exportedMath = await page.evaluate(html => {
    const exported = new DOMParser().parseFromString(html, 'text/html');
    const equations = [...exported.querySelectorAll('.meki-math mjx-container[jax="SVG"]')];
    return {
      count: equations.length,
      embeddedGlyphs: equations.every(equation => Boolean(equation.querySelector('svg path[d]'))),
      errors: exported.querySelectorAll('.meki-math-error').length,
    };
  }, html);
  assert.ok(exportedMath.count >= 3);
  assert.equal(exportedMath.embeddedGlyphs, true);
  assert.equal(exportedMath.errors, 0);
  assert.ok(html.includes('data:image/png;base64,'));
  assert.ok(!html.split('<body>')[1].includes('title: 私人文稿'));
  record('HTML export embeds SVG math/local images and omits YAML metadata');
  await menu(page, 'export-pdf');
  const pdf = await pollFile(pdfPath, b => b.length > 2000);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  record('PDF export produces a PDF');
  await fs.writeFile(documentPath, 'External version must survive');
  await rich.locator(':scope > p').last().click(); await page.keyboard.press(documentEndKey); await page.keyboard.insertText('冲突测试');
  await click(page, 'save');
  assert.equal(await fs.readFile(documentPath, 'utf8'), 'External version must survive');
  assert.equal(await page.locator('#dirty-dot').isVisible(), true);
  record('external file conflict cancels without overwriting either version');
  await click(page, 'new');
  await page.locator('[data-mode="source"]').click();
  await source.click(); await page.keyboard.insertText('---\n---\n\n# 空元数据\n\n恢复草稿 你好');
  await page.locator('[data-mode="visual"]').click();
  await rich.locator(':scope > p').last().click(); await page.keyboard.press(documentEndKey); await page.keyboard.insertText('！');
  await click(page, 'save');
  assert.ok((await fs.readFile(savePath, 'utf8')).startsWith('---\n---\n'));
  record('empty YAML survives visual editing');
  await rich.locator(':scope > p').last().click(); await page.keyboard.press(documentEndKey); await page.keyboard.insertText('未保存恢复内容');
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('未保存恢复内容'));
  const recoveryDeadline = Date.now() + 10000;
  while (!(await readWindows(env.MEKI_USER_DATA)).some(window => window.session?.documents.some(document => document.dirty && document.content.includes('未保存恢复内容')))) {
    assert.ok(Date.now() < recoveryDeadline, 'edited text reached the durable recovery store');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await exit();
  page = await launch();
  assert.equal(await page.locator('#recovery-banner').isVisible(), true);
  assert.ok((await page.locator('.ProseMirror').innerText()).includes('未保存恢复内容'));
  record('unsaved draft recovered after process restart');
  assert.deepEqual(errors, []);
  record('no renderer exceptions');
} finally {
  if (app) { try { await (await app.firstWindow()).screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000, animations: 'disabled' }); } catch (error) { console.log(`Screenshot: ${error.message}`); } }
  await exit();
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(`Evidence: ${run}`);
}

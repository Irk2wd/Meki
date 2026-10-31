import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(root, 'test-results', `appearance-math-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '公式与风格.md');
const cssPath = path.join(run, 'personal.css');
const htmlPath = path.join(run, 'export.html');
const fixture = String.raw`# 公式与风格

前向引用 $\eqref{质量}$，后续公式也可被 $\ref{force}$ 引用。

$$
\begin{align} E&=mc^2\label{质量} \\ F&=ma\label{force} \end{align}
$$

## 化学与物理

$$
\ce{2H2 + O2 -> 2H2O}
$$

$$
\dv{f}{x}+\bra{\psi}\ket{\phi}
$$

$$
x=1
$$

$$
x=1
$$

保留 TeX 原文。
`;
const customCss = '.meki-document h1 { color: #743d8f; } p { line-height: 2.1; } @media print { .meki-document h1 { font-style: italic; } } body + .titlebar { color:red!important; } @import "https://moye-test.invalid/theme.css"; @font-face { font-family:bad;src:url(https://moye-test.invalid/a.woff) }';
await fs.writeFile(documentPath, fixture);
await fs.writeFile(cssPath, customCss);
const env = { ...process.env, MOYE_TEST:'1', MOYE_USER_DATA:path.join(run,'profile'), MOYE_TEST_OPEN_PATH:documentPath, MOYE_TEST_THEME_PATH:cssPath, MOYE_TEST_EXPORT_HTML_PATH:htmlPath, MOYE_TEST_EXPORT_PDF_PATH:path.join(run,'export.pdf'), MOYE_TEST_DISCARD:'discard' };
delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = [], network = [];
let app, page;
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
async function launch() {
  app = await electron.launch({ executablePath:process.env.MOYE_EXECUTABLE || require('electron'), args:process.env.MOYE_EXECUTABLE ? [] : [root], env, timeout:30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]', {timeout:30000});
}
async function exit() { if (app) { await app.evaluate(({app}) => app.exit(0)).catch(()=>{}); await app.close().catch(()=>{}); app = null; } }
async function waitFile(file) { for (let i=0;i<100;i++) { const value=await fs.readFile(file).catch(()=>null); if(value?.length) return value; await new Promise(resolve=>setTimeout(resolve,50)); } throw Error(`Missing ${file}`); }
async function linksResolve(target) {
  return target.evaluate(() => [...document.querySelectorAll('.moye-document svg a[href^="#"]')].every(link => {
    const id = link.getAttribute('href').slice(1); return document.getElementById(id) || document.getElementById(decodeURIComponent(id));
  }));
}
try {
  await launch(); await action('open'); await action('style');
  await page.locator('#math-numbering').selectOption('ams');
  await page.locator('#math-physics').check();
  await page.waitForFunction(() => !document.querySelector('.ProseMirror .moye-math-error') && document.querySelectorAll('.ProseMirror mjx-container').length >= 7);
  assert.ok(await linksResolve(page));
  assert.equal(await page.locator('.ProseMirror [data-mml-node="mlabeledtr"]').count(),2);
  assert.ok(await page.locator('.ProseMirror path[data-c="E429"]').count());
  pass('AMS numbering, Unicode forward references, chemical glyphs and physics render offline');
  await page.locator('#math-numbering').selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror [data-mml-node="mlabeledtr"]').length === 6);
  const ids = await page.locator('.ProseMirror .moye-math svg [id]').evaluateAll(nodes=>nodes.map(node=>node.id));
  assert.equal(ids.length,new Set(ids).size,`Duplicate SVG ids: ${JSON.stringify(ids)}`);
  await page.locator('#math-physics').uncheck();
  await page.waitForSelector('.ProseMirror .moye-math-error');
  assert.match(await page.locator('.ProseMirror .moye-math-error').innerText(), /\\dv/);
  await page.locator('#math-physics').check();
  await page.waitForFunction(() => !document.querySelector('.ProseMirror .moye-math-error'));
  pass('all-equation numbering handles duplicate TeX and physics can be toggled without source loss');
  await page.locator('[data-theme="linen"]').click();
  await page.locator('#custom-font').fill('Consolas');
  await page.locator('#custom-font').press('Tab');
  await page.locator('#font-size').fill('22');
  await page.locator('#line-width').selectOption('640');
  const titlebarColor = await page.locator('.titlebar').evaluate(node=>getComputedStyle(node).color);
  await action('custom-theme'); await action('import-theme');
  assert.equal(await page.locator('#custom-css').inputValue(),customCss);
  await action('apply-theme');
  assert.equal(await page.locator('.ProseMirror h1').evaluate(node=>getComputedStyle(node).color),'rgb(116, 61, 143)');
  assert.equal(await page.locator('[id="write"]').count(), 0);
  assert.equal(await page.locator('.titlebar').evaluate(node=>getComputedStyle(node).color),titlebarColor);
  const live = await page.locator('.ProseMirror').evaluate(node=>({font:getComputedStyle(node).fontFamily,size:getComputedStyle(node).fontSize,background:getComputedStyle(node).backgroundColor}));
  assert.match(live.font,/Consolas/); assert.equal(live.size,'22px'); assert.equal(live.background,'rgb(250, 246, 238)');
  assert.equal(await page.locator('#dirty-dot').isVisible(),false);
  await action('save'); assert.equal(await fs.readFile(documentPath,'utf8'),fixture);
  await page.screenshot({path:path.join(run,'formula-theme.png')});
  pass('CSS import, installed font, size and width update typography without changing the Markdown file');
  await action('export-html');
  const html = (await waitFile(htmlPath)).toString();
  assert.ok(html.includes('<svg')); assert.ok(html.includes('max-width:640px')); assert.ok(!html.includes('moye-test.invalid'));
  const windowPromise = app.waitForEvent('window');
  await app.evaluate(async ({BrowserWindow},file)=>{const browser = new BrowserWindow({show:false,webPreferences:{partition:'moye-test-appearance-export',nodeIntegration:false,contextIsolation:true,sandbox:true}}); await browser.loadFile(file);},htmlPath);
  const exported = await windowPromise;
  await exported.waitForURL(pathToFileURL(htmlPath).href);
  await exported.waitForLoadState('load');
  await exported.waitForSelector('.moye-document mjx-container');
  assert.equal(await exported.locator('script').count(),0);
  assert.equal(await exported.locator('[id="write"]').count(),0);
  assert.equal(await exported.locator('.moye-math-error').count(),0);
  assert.equal(await exported.locator('[data-mml-node="mlabeledtr"]').count(),6);
  assert.ok(await linksResolve(exported));
  assert.equal(await exported.locator('h1').evaluate(node=>getComputedStyle(node).color),'rgb(116, 61, 143)');
  assert.deepEqual(await exported.locator('.moye-document').evaluate(node=>({font:getComputedStyle(node).fontFamily,size:getComputedStyle(node).fontSize,background:getComputedStyle(node).backgroundColor})),live);
  await exported.close();
  pass('standalone HTML retains the same theme, font and numbered SVG references');
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.ProseMirror').evaluate(node=>getComputedStyle(node).color),'rgb(67, 63, 52)');
  assert.equal(await page.locator('.ProseMirror h1').evaluate(node=>getComputedStyle(node).fontStyle),'italic');
  await page.emulateMedia({media:'screen'});
  await action('export-pdf');
  assert.equal((await waitFile(path.join(run,'export.pdf'))).subarray(0,5).toString(),'%PDF-');
  pass('print theme rules apply and PDF export succeeds with the new formulas');
  await action('new');
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click();
  await page.keyboard.insertText('# 新文稿\n\n$$\ny=2\\label{fresh}\n$$\n\n$\\eqref{fresh}$\n');
  await page.locator('[data-mode="visual"]').click();
  await page.waitForSelector('.ProseMirror svg [id$="-fresh"]');
  assert.equal(await page.locator('.ProseMirror svg [id$="-fresh"] [data-c="31"]').count(),1);
  assert.equal(await page.locator('.ProseMirror [data-mml-node="mlabeledtr"]').count(),1);
  assert.ok(await linksResolve(page));
  await action('open');
  pass('new documents restart numbering and do not retain another document’s labels');
  await exit(); await launch(); await action('open');
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror [data-mml-node="mlabeledtr"]').length === 6);
  await action('style');
  assert.equal(await page.locator('#math-numbering').inputValue(),'all');
  assert.equal(await page.locator('#math-physics').isChecked(),true);
  assert.equal(await page.locator('#custom-font').inputValue(),'Consolas');
  assert.equal(await page.locator('.ProseMirror h1').evaluate(node=>getComputedStyle(node).color),'rgb(116, 61, 143)');
  await action('custom-theme');
  await page.locator('#custom-css').fill('h1 { color: blue'); await action('apply-theme');
  assert.equal(await page.locator('#theme-dialog').isVisible(),true);
  assert.match(await page.locator('#theme-feedback').innerText(),/CSS 格式有误/);
  assert.equal(await page.locator('.ProseMirror h1').evaluate(node=>getComputedStyle(node).color),'rgb(116, 61, 143)');
  await action('reset-theme');
  assert.notEqual(await page.locator('.ProseMirror h1').evaluate(node=>getComputedStyle(node).color),'rgb(116, 61, 143)');
  pass('settings survive restart; malformed CSS does not replace the applied theme; reset works');
  assert.deepEqual(errors,[]); assert.deepEqual(network,[]);
  pass('no renderer errors or network requests during local math and theme use');
} finally {
  if(app) {
    await page.screenshot({path:path.join(run,'last-state.png'),timeout:5000}).catch(()=>{});
    const state = await page.evaluate(()=>({math:document.querySelectorAll('.ProseMirror mjx-container').length,errors:[...document.querySelectorAll('.ProseMirror .moye-math-error')].map(node=>node.textContent),blocks:[...document.querySelectorAll('.milkdown-code-block')].map(node=>({class:node.className,preview:node.querySelector('.preview')?.innerHTML.slice(0,250),text:node.textContent.slice(0,160)}))})).catch(()=>null);
    await fs.writeFile(path.join(run,'last-state.json'),JSON.stringify(state,null,2));
  }
  await exit(); await fs.writeFile(path.join(run,'results.json'),JSON.stringify({results,errors,network},null,2));
  console.log(`Evidence: ${run}`);
}

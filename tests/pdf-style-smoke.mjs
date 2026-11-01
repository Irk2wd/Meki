import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'pdf-style-')));
const documentPath = path.join(run, '预览与导出.md');
const code = 'const message = "<em>Hello, PDF</em>";\n// Keep the preview colors\nconsole.log(message, 42);';
const fixture = '\uFEFF' + `# 预览与导出\n\n正文 **粗体**、*斜体*、[链接](https://example.com) 与 \`inline code\`。\n\n> 引用也应保留原来的颜色与字体。\n\n## 表格与列表\n\n| 名称 | 值 |\n| --- | --- |\n| Alpha | 42 |\n\n- 普通列表\n- 第二项\n\n\`\`\`javascript\n${code}\n\`\`\`\n\n公式 $E=mc^2$。\n\n$$\n\\int_0^1 x^2\\,dx=\\frac13\n$$\n\n\`\`\`mermaid\nflowchart LR\n A[预览] --> B[PDF]\n\`\`\`\n\n![本地图片](sample.png)\n\n---\n\n末尾文字。\n`.replaceAll('\n', '\r\n');
await fs.writeFile(documentPath, fixture);
await require('sharp')({ create: { width: 160, height: 60, channels: 3, background: '#517b66' } }).png().toFile(path.join(run, 'sample.png'));
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await idle(); await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); }
async function poll(check, label) { const limit = Date.now() + 20000; while (Date.now() < limit) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw Error(`Timed out: ${label}`); }
function appearance(mode) {
  const root = document.querySelector(mode === 'editor' ? '#visual-editor .ProseMirror' : '.meki-document');
  const selectors = {
    root: null, h1: 'h1', h2: 'h2', paragraph: 'p', strong: 'strong', emphasis: 'em', link: 'a[href^="https:"]', quote: 'blockquote', quoteText: 'blockquote p', inline: 'p code', list: 'li', table: 'table', header: 'th', cell: 'td',
    code: mode === 'editor' ? '.milkdown-code-block .cm-content' : 'pre code', keyword: '.meki-code-keyword', math: '.meki-math', rule: 'hr',
  };
  const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'borderLeftColor', 'borderLeftWidth', 'borderBottomColor', 'borderBottomWidth', 'textDecorationLine'];
  return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
    const node = selector ? root.querySelector(selector) : root;
    if (!node) throw Error(`Missing ${name} in ${mode}`);
    const style = getComputedStyle(node);
    return [name, Object.fromEntries(properties.map(property => [property, style[property]]))];
  }));
}
const compared = {
  root: ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor'],
  h1: ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color'], h2: ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color'],
  paragraph: ['fontSize', 'lineHeight', 'letterSpacing', 'color'], strong: ['fontWeight', 'color'], emphasis: ['fontStyle', 'color'],
  link: ['color', 'textDecorationLine', 'borderBottomColor', 'borderBottomWidth'], quote: ['color', 'borderLeftColor', 'borderLeftWidth'], quoteText: ['fontStyle', 'lineHeight', 'color'],
  inline: ['fontFamily', 'fontSize', 'lineHeight', 'color', 'backgroundColor'], list: ['fontFamily', 'fontSize', 'lineHeight', 'color'],
  table: ['fontFamily', 'fontSize', 'color'], header: ['fontWeight', 'lineHeight', 'backgroundColor', 'borderLeftColor'], cell: ['lineHeight', 'borderLeftColor'],
  code: ['fontFamily', 'fontSize', 'lineHeight', 'color'], keyword: ['color'], math: ['fontSize', 'color'], rule: ['borderLeftColor'],
};
async function exportPdf(name, configure) {
  const file = path.join(run, `${name}.pdf`);
  await app.evaluate((_electron, file) => { process.env.MEKI_TEST_EXPORT_PDF_PATH = file; }, file);
  if (configure) { await action('export-options'); await configure(); await page.locator('#confirm-export').click(); await page.locator('#export-dialog').waitFor({ state: 'hidden' }); }
  else await action('export-pdf');
  await poll(async () => (await fs.stat(file).catch(() => null))?.size > 100, 'PDF export'); await idle();
  assert.equal((await fs.readFile(file)).subarray(0, 5).toString(), '%PDF-');
  return app.evaluate(() => globalThis.pdfStyleCaptures.at(-1));
}
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: [...(process.env.MEKI_EXECUTABLE ? [] : [root]), '--force-device-scale-factor=1', '--open', documentPath], env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#shell[data-ready="true"]');
  await app.evaluate(({ app }, probe) => {
    globalThis.pdfStyleCaptures = [];
    app.on('web-contents-created', (_event, contents) => {
      const print = contents.printToPDF.bind(contents);
      contents.printToPDF = async options => {
        contents.debugger.attach('1.3');
        try {
          await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
          const styles = await contents.executeJavaScript(`(${probe})('export')`);
          const content = await contents.executeJavaScript(`({body: getComputedStyle(document.body).backgroundColor, pageBackground: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule => rule instanceof CSSPageRule)?.style.backgroundColor, code: document.querySelector('pre code').textContent, codeMarkup: document.querySelector('pre code').querySelectorAll('script,em').length, math: [...document.querySelectorAll('.meki-math')].filter(node => node.querySelector('mjx-container > svg')).length, diagrams: document.querySelectorAll('.meki-diagram svg').length, images: [...document.images].map(image => ({ src: image.src, complete: image.complete && image.naturalWidth > 0 })), html: document.documentElement.outerHTML})`);
          globalThis.pdfStyleCaptures.push({ styles, content, options });
        } finally { contents.debugger.detach(); }
        return print(options);
      };
    });
  }, appearance.toString());

  for (const theme of ['paper', 'linen', 'night']) {
    await action('style'); await page.locator(`button[data-theme="${theme}"]`).click(); await page.locator('#custom-font').fill('Georgia'); await page.locator('#custom-font').press('Tab');
    await page.locator('#font-size').fill('20'); await page.locator('#line-width').selectOption('640');
    await action('style');
    await page.locator('.milkdown-code-block,.milkdown-code-block-placeholder').first().scrollIntoViewIfNeeded();
    await page.locator('.meki-code-keyword').first().waitFor();
    const live = await page.evaluate(appearance, 'editor'), exported = await exportPdf(theme);
    await fs.writeFile(path.join(run, `${theme}-styles.json`), JSON.stringify({ live, exported }, null, 2));
    for (const [part, properties] of Object.entries(compared)) for (const property of properties) assert.equal(exported.styles[part][property], live[part][property], `${theme}: ${part}.${property}`);
    assert.equal(exported.content.body, live.root.backgroundColor); assert.equal(exported.content.code, code + '\n'); assert.equal(exported.content.codeMarkup, 0);
    assert.equal(exported.content.pageBackground, live.root.backgroundColor);
    assert.equal(exported.content.math, 2); assert.equal(exported.content.diagrams, 1); assert.ok(exported.content.images.every(image => image.complete && image.src.startsWith('data:')));
    assert.equal(exported.options.printBackground, true); assert.equal(exported.options.pageSize, 'A4');
    await page.locator('#document-scroll').evaluate(node => { node.scrollTop = 0; }); await page.screenshot({ path: path.join(run, `${theme}-preview.png`) });
    pass(`${theme} PDF uses the live preview's colors, fonts, links, quotes, tables, code highlights and decoded vector/image assets`);
  }
  const nightPages = await exportPdf('night-pages', async () => {
    await page.locator('#export-kind').selectOption('pdf'); await page.locator('#pdf-header').check(); await page.locator('#pdf-pages').check();
  });
  assert.ok(nightPages.options.headerTemplate.includes(`color:${nightPages.styles.root.color}`));
  assert.ok(nightPages.options.footerTemplate.includes(`color:${nightPages.styles.root.color}`));
  pass('PDF page margins retain the theme background and dark pages use legible headers and page numbers');
  await action('custom-theme'); await page.locator('#custom-css').fill('h1 { color:#b05bd2; letter-spacing:.04em; } p { line-height:2.15; } blockquote p { font-style:normal; }'); await action('apply-theme');
  await page.locator('.milkdown-code-block,.milkdown-code-block-placeholder').first().scrollIntoViewIfNeeded(); await page.locator('.meki-code-keyword').first().waitFor();
  const customized = await page.evaluate(appearance, 'editor'), exported = await exportPdf('custom');
  for (const part of ['h1', 'paragraph', 'quoteText']) for (const property of compared[part]) assert.equal(exported.styles[part][property], customized[part][property], `custom ${part}.${property}`);
  pass('custom document typography survives PDF printing without the former forced white palette');

  const selected = await exportPdf('paper-override', async () => {
    await page.locator('#export-kind').selectOption('pdf'); await page.locator('#export-theme').selectOption('paper'); await page.locator('#export-font-size').fill('24');
    await page.locator('#pdf-paper').selectOption('Letter'); await page.locator('#pdf-orientation').selectOption('landscape'); await page.locator('#pdf-margin').fill('15');
    await page.locator('#pdf-header').check(); await page.locator('#pdf-pages').check();
  });
  assert.equal(selected.styles.root.backgroundColor, 'rgb(255, 255, 255)'); assert.equal(selected.styles.root.fontSize, '24px');
  assert.equal(selected.options.landscape, true); assert.equal(selected.options.pageSize, 'Letter'); assert.equal(selected.options.displayHeaderFooter, true);
  assert.deepEqual(await page.evaluate(appearance, 'editor'), customized);
  assert.equal(await fs.readFile(documentPath, 'utf8'), fixture);
  pass('explicit PDF appearance overrides and paper/header settings leave editor appearance and exact Markdown bytes unchanged');
  assert.deepEqual(errors, []); pass('no renderer exceptions');
} finally {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  console.log(`Evidence: ${run}`);
}

import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../src/markdown-render.ts';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const run = await fs.mkdtemp(path.join(root, 'test-results', 'extensions-'));
const documentPath = path.join(run, '兼容性.md'), htmlPath = path.join(run, '兼容性.html');
const body = '[TOC]\n\n# 兼容性\n\nH~2~O x^2^ ==高亮 **粗体**== :smile: ~~删除~~\n\n> [!NOTE]\n> 提示里有 **粗体** 和 H~2~O。\n>\n> - 内嵌列表\n\n正文脚注[^注]。\n\n`~不转换~ ^原样^ ==原样== :smile:` 和 $x^2$。\n\n\\[TOC]\n\n\\~原样\\~ \\^原样\\^ \\==原样== \\:smile:\n\n<script>window.__mdExecuted = true</script>\n\n<div onclick="window.__mdExecuted=true">原始 HTML</div>\n\n## 重复标题\n\n' + Array.from({ length: 8 }, (_, i) => `滚动段落 ${i + 1}。`).join('\n\n') + '\n\n## 重复标题\n\n![本地图片](local.png)\n\n[^注]: 脚注 **内容**。\n\n编辑尾点\n';
const original = '\uFEFF---\r\ntitle: 隐藏的元数据\r\n---\r\n\r\n' + body.replaceAll('\n', '\r\n');
await fs.writeFile(documentPath, original); await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(run, 'local.png'));
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_OPEN_PATH: documentPath, MEKI_TEST_EXPORT_HTML_PATH: htmlPath, MEKI_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const results = [], errors = []; let app, page;
const record = message => { results.push(message); console.log(`PASS ${message}`); };
const semantic = node => { const { position, data, ...value } = node; if (value.children) value.children = value.children.map(semantic); return value; };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? [] : [root], env });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]'); await action('open');
  const rich = page.locator('#visual-editor .ProseMirror').first(); await rich.locator('.meki-toc').waitFor();
  assert.equal(await rich.locator('.meki-alert[data-kind="note"]').count(), 1);
  assert.equal(await rich.locator('sub').count(), 2); assert.equal((await rich.locator('mark').allTextContents()).join(''), '高亮 粗体');
  assert.equal(await rich.locator('.meki-emoji').count(), 1); assert.equal(await rich.locator('.meki-raw-html').count(), 2);
  assert.equal(await rich.locator('nav.meki-toc a').count(), 3);
  await rich.locator('.meki-math').first().waitFor();
  assert.equal(await page.evaluate(() => window.__mdExecuted), undefined);
  record('rich nodes render TOC, alerts, sub/sup/highlight/emoji, raw HTML and math');
  await page.locator('[data-mode="source"]').click(); await page.locator('[data-mode="visual"]').click(); await action('save');
  assert.equal(await fs.readFile(documentPath, 'utf8'), original); record('untouched source/visual switching preserves BOM, CRLF and all source bytes');
  await rich.locator('.meki-toc a').last().click();
  await page.waitForFunction(() => document.querySelector('#document-scroll').scrollTop > 200);
  await rich.locator('sup[data-type="footnote_reference"] a').click();
  await page.waitForFunction(() => {
    const target = document.querySelector('[id="meki-fn-注"]'), scroller = document.querySelector('#document-scroll');
    const rect = target.getBoundingClientRect(), bounds = scroller.getBoundingClientRect(); return rect.top >= bounds.top && rect.top < bounds.bottom;
  }); record('TOC and footnote references scroll to document anchors');
  await rich.locator(':scope > p').last().click(); await page.keyboard.press(`${modifier}+End`); await page.keyboard.insertText('视觉新增'); await action('save');
  const saved = await fs.readFile(documentPath, 'utf8'); assert.ok(saved.includes('视觉新增'));
  assert.ok(saved.startsWith('\uFEFF---\r\ntitle: 隐藏的元数据\r\n---\r\n'));
  assert.deepEqual(semantic(parseMarkdown(saved.replace('视觉新增', ''))), semantic(parseMarkdown(original)));
  await action('open'); await rich.locator('.meki-toc').waitFor(); assert.equal(await rich.locator('sub').count(), 2); assert.equal(await rich.locator('.meki-alert').count(), 1);
  record('actual rich edit, immediate save and reopen preserve supported Markdown structure');
  await rich.locator('[data-type="math_inline"]').click();
  const inlineEditor = page.locator('.milkdown-latex-inline-edit .ProseMirror'); await inlineEditor.waitFor({ state: 'visible' });
  await inlineEditor.click(); await page.keyboard.press(`${modifier}+A`); await page.keyboard.insertText('x^3'); await page.keyboard.press('Enter');
  await rich.locator(':scope > p').last().click(); await action('save');
  assert.ok((await fs.readFile(documentPath, 'utf8')).includes('$x^3$'));
  await page.waitForFunction(() => document.querySelector('[data-type="math_inline"] .meki-math')?.getAttribute('aria-label') === 'x^3');
  record('clicking inline MathJax opens TeX editor and updates saved source and preview');
  await action('export-html'); const html = await fs.readFile(htmlPath, 'utf8');
  assert.ok(html.includes('data:image/png;base64,')); assert.ok(html.includes('meki-math')); assert.ok(!html.includes('<script>'));
  const windowReady = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => { const win = new BrowserWindow({ show: false, webPreferences: { partition: 'meki-test-export', sandbox: true, nodeIntegration: false, contextIsolation: true } }); await win.loadFile(file); }, htmlPath);
  const exported = await windowReady; await exported.waitForLoadState('domcontentloaded');
  assert.equal(await exported.locator('.meki-toc a').count(), 3); assert.equal(await exported.locator('.meki-alert').count(), 1);
  assert.equal(await exported.locator('sub').count(), 2); assert.equal(await exported.locator('mark').count(), 1); assert.equal(await exported.locator('.meki-emoji').count(), 1);
  assert.equal(await exported.locator('script,[onerror],[onclick]').count(), 0);
  assert.equal(await exported.evaluate(() => window.__mdExecuted), undefined);
  assert.ok(!(await exported.locator('body').innerText()).includes('隐藏的元数据'));
  await exported.locator('.meki-toc a').last().click(); await exported.waitForFunction(() => location.hash.length > 1);
  assert.ok(await exported.locator('[data-footnote-ref]').count());
  await exported.locator('[data-footnote-ref]').click(); await exported.waitForFunction(() => location.hash.includes('fn-'));
  assert.ok(await exported.locator('.footnotes [data-footnote-backref]').count());
  record('standalone export includes local image, linked footnotes, matching extensions and safe source HTML');
  await action('new'); await rich.click(); await page.keyboard.type('H~2~O x^2^ ==hi== :smile: ~~gone~~');
  for (const selector of ['sub', 'sup', 'mark', '.meki-emoji', 'del']) assert.equal(await rich.locator(selector).count(), 1, selector);
  await action('new'); await rich.click(); await page.keyboard.type('[TOC] '); assert.equal(await rich.locator('nav.meki-toc').count(), 1);
  await action('new'); await rich.click(); await page.keyboard.type('> [!TIP] '); assert.equal(await rich.locator('.meki-alert[data-kind="tip"]').count(), 1);
  record('typing delimiters creates inline extension marks, TOC and alert nodes immediately');
  await page.screenshot({ path: path.join(run, 'editor.png'), animations: 'disabled' });
  assert.deepEqual(errors, []); record('no renderer exceptions');
} finally {
  if (page) { await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')).catch(() => {}); await page.screenshot({ path: path.join(run, 'last-state.png'), animations: 'disabled' }).catch(() => {}); }
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

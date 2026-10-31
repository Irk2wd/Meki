import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(root, 'test-results', `diagrams-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '图表.md'), htmlPath = path.join(run, 'export.html'), pdfPath = path.join(run, 'export.pdf');
const diagrams = [
  ['流程图', 'flowchart LR\n A[开始] --> B{是否完成}\n B -->|是| C[完成]\n B -->|否| A'],
  ['时序图', 'sequenceDiagram\n participant A as 读者\n participant B as 编辑器\n A->>B: 输入中文\n B-->>A: 即时预览'],
  ['类图', 'classDiagram\n class Document {\n +String title\n +save()\n }\n class Editor\n Editor --> Document : 编辑'],
  ['状态图', 'stateDiagram-v2\n [*] --> Draft\n Draft --> Saved: 保存\n Saved --> [*]'],
  ['关系图', 'erDiagram\n USER ||--o{ DOCUMENT : writes\n USER {\n string name\n }\n DOCUMENT {\n string title\n }'],
  ['甘特图', 'gantt\n title 开发计划\n dateFormat YYYY-MM-DD\n section 实现\n 图表预览 :a, 2026-10-21, 2d\n 验证 :after a, 1d'],
  ['思维导图', 'mindmap\n root((墨页))\n  写作\n   公式\n   图表\n  导出'],
];
const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;
const spacer = Array.from({ length: 50 }, (_, index) => `离屏测试段落 ${index + 1}：文稿必须包含视口外的完整图表。`).join('\n\n');
const fixture = `# 离线图表\n\n${diagrams.map(([name, source]) => `## ${name}\n\n${fence(source)}`).join('\n\n')}\n\n${spacer}\n\n## 相同图表的独立 SVG\n\n${fence(diagrams[0][1])}\n\n## 文末图表\n\n${fence('flowchart TD\n X[文末] --> Y[完整导出]')}\n`;
await fs.writeFile(documentPath, fixture);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_OPEN_PATH: documentPath, MOYE_TEST_EXPORT_HTML_PATH: htmlPath, MOYE_TEST_EXPORT_PDF_PATH: pdfPath, MOYE_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = [], network = [];
let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
async function waitReady(count, theme) { await page.waitForFunction(({ count, theme }) => [...document.querySelectorAll('.ProseMirror .moye-diagram[data-diagram-state="ready"]')].filter(node => !theme || node.dataset.diagramTheme === theme).length === count, { count, theme }, { timeout: 30000 }); }
async function source(value) {
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(value);
  await page.locator('[data-mode="visual"]').click();
}
async function waitFile(file) { for (let i = 0; i < 100; i++) { const value = await fs.readFile(file).catch(() => null); if (value?.length) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Missing ${file}`); }
async function assertSvg(target, expected) {
  const state = await target.evaluate(() => {
    const diagrams = [...document.querySelectorAll('.moye-document .moye-diagram[data-diagram-state="ready"]')];
    const ids = diagrams.flatMap(node => [...node.querySelectorAll('[id]')].map(item => item.id));
    return { count: diagrams.length, ids, labels: diagrams.map(node => [...node.querySelectorAll('text')].map(text => text.textContent).join(' ')), sizes: diagrams.map(node => { const svg = node.querySelector('svg'); return svg ? { width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height, background: svg.style.backgroundColor } : null; }), unsafe: diagrams.flatMap(node => [...node.querySelectorAll('script,foreignObject,image,a[href]')].map(item => item.outerHTML)), outside: diagrams.flatMap(node => [...node.querySelectorAll('*')].flatMap(item => [...item.attributes].filter(attr => /href$/.test(attr.name) && !attr.value.startsWith('#')).map(attr => attr.value))) };
  });
  assert.equal(state.count, expected); assert.equal(state.ids.length, new Set(state.ids).size, `Every diagram has independent SVG IDs: ${state.ids.filter((id, index) => state.ids.indexOf(id) !== index).join(', ')}`);
  assert.ok(state.sizes.every(size => size && size.width > 0 && size.height > 0), JSON.stringify(state.sizes));
  assert.deepEqual(state.unsafe, []); assert.deepEqual(state.outside, []);
  return state;
}
try {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? [] : [root], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
  await action('open'); await waitReady(9, 'paper');
  const first = await assertSvg(page, 9);
  for (const [index, label] of [[0, '开始'], [1, '读者'], [2, 'Document'], [3, '保存'], [4, 'USER'], [5, '开发计划'], [6, '墨页'], [8, '完整导出']]) assert.ok(first.labels[index].includes(label), `${index}: ${first.labels[index]}`);
  assert.ok(await page.locator('.moye-lazy-diagram svg').count() > 0);
  assert.ok(await page.locator('.moye-diagram svg').nth(2).evaluate(svg => svg.getBoundingClientRect().width <= svg.viewBox.baseVal.width + 1));
  assert.equal(await page.locator('.moye-diagram-measure').count(), 0);
  await page.screenshot({ path: path.join(run, 'paper.png') });
  pass('seven diagram families render Chinese labels offline, including duplicate and offscreen blocks');

  await action('save'); assert.equal(await fs.readFile(documentPath, 'utf8'), fixture);
  pass('viewing diagrams and saving preserves untouched Markdown bytes');
  await action('style'); await page.locator('[data-theme="linen"]').click(); await waitReady(9, 'linen');
  assert.equal((await assertSvg(page, 9)).sizes[0].background, 'rgb(250, 246, 238)');
  await page.locator('[data-theme="night"]').click(); await waitReady(9, 'night');
  assert.equal((await assertSvg(page, 9)).sizes[0].background, 'rgb(32, 37, 33)');
  assert.ok(await page.locator('.moye-diagram svg').nth(6).evaluate(svg => [...svg.querySelectorAll('.mindmap-node rect')].every(node => getComputedStyle(node).fill !== 'rgb(0, 0, 0)')));
  await page.locator('.ProseMirror h1').click();
  await page.screenshot({ path: path.join(run, 'night.png') });
  pass('paper, linen and night themes update every diagram without editing the source');

  await action('export-html'); const html = (await waitFile(htmlPath)).toString();
  await fs.writeFile(path.join(run, 'diagrams-export.html'), html);
  assert.ok(html.includes('完整导出')); assert.ok(!html.includes('moye-diagram-measure'));
  const opened = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => { const browser = new BrowserWindow({ show: true, webPreferences: { partition: 'moye-test-diagram-export', nodeIntegration: false, contextIsolation: true, sandbox: true } }); await browser.loadFile(file); }, htmlPath);
  const exported = await opened; exported.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await exported.waitForURL(pathToFileURL(htmlPath).href); await exported.waitForLoadState('load');
  const exportedState = await assertSvg(exported, 9); assert.equal(await exported.locator('script').count(), 0);
  assert.deepEqual(exportedState.labels, first.labels); assert.equal(exportedState.sizes[0].background, 'rgb(32, 37, 33)');
  await exported.screenshot({ path: path.join(run, 'html-export.png') });
  for (const index of [1, 2, 3, 4, 5, 6]) await exported.locator('.moye-diagram[data-diagram-state="ready"]').nth(index).screenshot({ path: path.join(run, `diagram-${index}.png`) });
  await exported.close();
  await action('export-pdf'); assert.equal((await waitFile(pdfPath)).subarray(0, 5).toString(), '%PDF-');
  await page.emulateMedia({ media: 'print' });
  // Print layout can remount Crepe's lazy code views. Wait for their observer-
  // driven previews to settle before inspecting the editor's print DOM.
  await waitReady(9, 'night');
  assert.equal(await page.locator('.ProseMirror .moye-diagram svg').count(), 9);
  assert.ok(await page.locator('.ProseMirror .moye-diagram svg').last().isVisible());
  await page.emulateMedia({ media: 'screen' });
  pass('standalone HTML and PDF contain complete styled SVG, including diagrams never scrolled into view');

  await source(`# 编辑图表\n\n${fence('flowchart LR\n A[未闭合')}\n`);
  await page.waitForSelector('.ProseMirror .moye-diagram-error');
  assert.ok((await page.locator('.moye-diagram-error').innerText()).includes('A[未闭合'));
  await source(`# 编辑图表\n\n${fence('flowchart LR\n A[修复] --> B[可编辑]')}\n`); await waitReady(1, 'night');
  const block = page.locator('.milkdown-code-block').first();
  await block.locator('.preview').click();
  await block.locator('.codemirror-host:not(.hidden) .cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText('flowchart LR\n A[直接编辑] --> B[即时更新]');
  await page.waitForFunction(() => document.querySelector('.ProseMirror .moye-diagram svg')?.textContent.includes('即时更新'));
  await action('save'); assert.match(await fs.readFile(documentPath, 'utf8'), /直接编辑/);
  await block.locator('.preview-toggle-button').click();
  pass('syntax errors retain source and recover; clicking a diagram enables live code editing and saving');

  await action('new'); await action('diagram'); await waitReady(1, 'night');
  assert.match(await page.locator('.ProseMirror .moye-diagram svg').textContent(), /开始/);
  await page.locator('[data-mode="source"]').click(); assert.match(await page.locator('#source-editor .cm-content').innerText(), /```mermaid/);
  await page.locator('[data-mode="visual"]').click();
  pass('toolbar inserts a standard editable Mermaid fence with a Chinese flowchart');

  const hostile = [
    '%%{init:{"securityLevel":"loose","themeCSS":"body{color:red}"}}%%\nflowchart LR\nA-->B',
    'flowchart LR\nA[危险]-->B\nclick A "https://moye-test.invalid/click"',
    'flowchart LR\nA@{img: "https://moye-test.invalid/image"}',
    'flowchart LR\nA[<img src="https://moye-test.invalid/html" onerror="alert(1)">]',
    'flowchart LR\nA-->B\nstyle A fill:u\\72l(https://moye-test.invalid/paint)',
  ];
  await source(`# 限制外部行为\n\n${hostile.map(fence).join('\n\n')}\n\n${fence('flowchart LR\n X[仍可使用] --> Y[正常]')}\n`);
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .moye-diagram-error').length === 5); await waitReady(1, 'night');
  assert.equal(await page.locator('.ProseMirror .moye-diagram image,.ProseMirror .moye-diagram script,.ProseMirror .moye-diagram foreignObject').count(), 0);
  await action('export-html'); const safe = (await waitFile(htmlPath)).toString();
  assert.equal((safe.match(/data-diagram-state="error"/g) || []).length, 5);
  assert.ok(!safe.includes('<img src="https://moye-test.invalid'));
  await page.screenshot({ path: path.join(run, 'safe-errors.png') });
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  pass('configuration, links, HTML, images and disguised CSS resources are blocked without network requests');
} finally {
  if (app) {
    await page.screenshot({ path: path.join(run, 'last-state.png'), timeout: 5000 }).catch(() => {});
    await fs.writeFile(path.join(run, 'last-state.json'), JSON.stringify(await page.evaluate(() => ({ ready: document.querySelectorAll('.ProseMirror .moye-diagram[data-diagram-state="ready"]').length, errors: [...document.querySelectorAll('.ProseMirror .moye-diagram-error')].map(node => node.textContent), blocks: [...document.querySelectorAll('.milkdown-code-block')].map(node => node.innerHTML.slice(0, 1000)) })).catch(() => null), null, 2));
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});
  }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, network }, null, 2));
  console.log(`Evidence: ${run}`);
}

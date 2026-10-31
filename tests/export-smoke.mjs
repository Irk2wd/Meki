import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(root, 'test-results', `export-${Date.now()}`); await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '导出源.md'), importedPath = path.join(run, '导入后.md');
await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#284b63"/><circle cx="200" cy="120" r="60" fill="white"/></svg>')).png().toFile(path.join(run, 'sized.png'));
const output = Object.fromEntries(['pdf','png','html','plain-html','docx','epub'].map(kind => [kind, path.join(run, `export-${kind}.${kind.includes('html') ? 'html' : kind}`)]));
const fixture = String.raw`---
filters: [must-not-run.lua]
---
# 导出验证

正文与行内公式 $E=mc^2$。

$$
\ce{2H2 + O2 -> 2H2O}
$$

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

$$
\cancel{x}
$$

` + '```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```\n\n<img src="sized.png" alt="尺寸集成图" title="尺寸说明" width="180" height="90">\n\n快照末尾。\n';
await fs.writeFile(documentPath, fixture);
const env = { ...process.env, MOYE_TEST:'1', MOYE_USER_DATA:path.join(run,'profile'), MOYE_TEST_OPEN_PATH:documentPath, MOYE_TEST_SAVE_PATH:importedPath, MOYE_TEST_IMPORT_PATH:output.docx, MOYE_TEST_DISCARD:'discard', MOYE_TEST_DIAGRAM_SVG_PATH:path.join(run,'diagram.svg'), MOYE_TEST_DIAGRAM_PNG_PATH:path.join(run,'diagram.png') };
for (const [kind, file] of Object.entries(output)) env[`MOYE_TEST_EXPORT_${kind.replace('-', '_').toUpperCase()}_PATH`] = file;
delete env.ELECTRON_RUN_AS_NODE;
let app, page; const results = [], errors = [], skipped = [];
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy'), undefined, { timeout:60000 }); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
async function exportWith(kind, configure = async () => {}) { await action('export-options'); await page.locator('#export-kind').selectOption(kind); await configure(); await page.locator('#confirm-export').click(); await page.locator('#export-dialog').waitFor({state:'hidden'}); await idle(); }
async function bytes(file) { for (let i=0;i<100;i++) { const value = await fs.readFile(file).catch(()=>null); if(value?.length>100) return value; await new Promise(resolve=>setTimeout(resolve,50)); } throw new Error(`Missing output: ${file}`); }
async function readableInk(image) {
  const sharp = require('sharp'), {data,info} = await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true}); let dark = 0;
  for(let offset=0;offset<data.length;offset+=info.channels) if(data[offset+3]>128 && Math.max(data[offset],data[offset+1],data[offset+2])<180) dark++;
  assert.ok(dark>15,'PNG must have dark, nontransparent strokes for white Word/EPUB/unstyled HTML pages');
}
async function zipEntries(file) {
  const data = await bytes(file), entries = new Map();
  const end = data.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])); assert.ok(end>=0,'ZIP end record');
  let offset = data.readUInt32LE(end+16);
  for (let n=0;n<data.readUInt16LE(end+10);n++) {
    assert.equal(data.readUInt32LE(offset),0x02014b50);
    const method = data.readUInt16LE(offset+10), compressed = data.readUInt32LE(offset+20), size = data.readUInt32LE(offset+24);
    const length = data.readUInt16LE(offset+28), extra = data.readUInt16LE(offset+30), comment = data.readUInt16LE(offset+32), local = data.readUInt32LE(offset+42);
    const name = data.toString('utf8',offset+46,offset+46+length); assert.ok([0,8].includes(method)); assert.ok(size<32*1024*1024);
    const start = local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28), payload = data.subarray(start,start+compressed);
    const decoded = method===0 ? payload : inflateRawSync(payload,{maxOutputLength:32*1024*1024}); assert.equal(decoded.length,size); entries.set(name,decoded);
    offset += 46+length+extra+comment;
  }
  return entries;
}
try {
  app = await electron.launch({ executablePath:process.env.MOYE_EXECUTABLE || require('electron'), args:process.env.MOYE_EXECUTABLE ? [] : [root], env, timeout:30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]'); await action('open');
  await page.waitForSelector('.ProseMirror .moye-diagram svg');
  const inlineMath = page.locator('.ProseMirror .moye-inline-math').first();
  await inlineMath.click({ button: 'right' }); await page.locator('[data-math-copy="tex"]').click();
  await page.waitForFunction(async () => (await window.moye.readClipboardText()) === 'E=mc^2');
  await inlineMath.click({ button: 'right' }); await page.locator('[data-math-copy="mathml"]').click();
  await page.waitForFunction(async () => (await window.moye.readClipboardText()).startsWith('<math'));
  const copied = await page.evaluate(async () => { const xml = new DOMParser().parseFromString(await window.moye.readClipboardText(), 'application/xml'); return { error: !!xml.querySelector('parsererror'), namespace: xml.documentElement.namespaceURI, text: xml.documentElement.textContent }; });
  assert.equal(copied.error, false); assert.equal(copied.namespace, 'http://www.w3.org/1998/Math/MathML'); assert.match(copied.text, /E/);
  await action('math'); await page.locator('#math-input').fill('\\frac{1}{2}'); await page.locator('[data-preview-copy="mathml"]').click();
  await page.waitForFunction(async () => (await window.moye.readClipboardText()).includes('<mfrac>'));
  await page.locator('#math-input').fill('\\unknownMoyeCommand'); await page.locator('[data-preview-copy="mathml"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('公式存在错误'));
  assert.ok((await page.evaluate(() => window.moye.readClipboardText())).includes('<mfrac>'));
  await page.locator('[aria-label="关闭公式窗口"]').click(); assert.equal(await fs.readFile(documentPath, 'utf8'), fixture);
  pass('formula context menu and dialog copy LaTeX or valid MathML without changing document bytes; invalid formulas retain the clipboard');
  await page.locator('#format-menu-button').click(); await page.locator('[data-edit-command="heading-numbering"]').click();
  await page.waitForFunction(() => document.querySelector('.ProseMirror h1')?.getAttribute('data-heading-number') === '1');
  await exportWith('pdf', async () => { await page.locator('#pdf-paper').selectOption('Letter'); await page.locator('#pdf-orientation').selectOption('landscape'); await page.locator('#pdf-margin').fill('15'); await page.locator('#pdf-pages').check(); await page.locator('#pdf-header').check(); await page.screenshot({ path:path.join(run,'export-settings.png') }); });
  const pdf = await bytes(output.pdf); assert.equal(pdf.subarray(0,5).toString(),'%PDF-'); assert.equal(pdf.toString('latin1').match(/\/MediaBox\s*\[([^\]]+)\]/)?.[1].trim(),'0 0 792 612');
  await exportWith('pdf', async () => { await page.locator('#pdf-paper').selectOption('A5'); await page.locator('#pdf-orientation').selectOption('portrait'); });
  const a5 = (await bytes(output.pdf)).toString('latin1').match(/\/MediaBox\s*\[([^\]]+)\]/)?.[1].trim().split(/\s+/).map(Number); assert.ok(a5 && Math.abs(a5[2]-419.53)<1 && Math.abs(a5[3]-595.28)<1,JSON.stringify(a5));
  pass('PDF settings produce Letter landscape and A5 portrait with bounded margins and header/footer');
  await action('export-options'); await page.locator('#pdf-margin').fill('5'); await page.locator('#confirm-export').click();
  assert.equal(await page.locator('#export-dialog').isVisible(),true); assert.match(await page.locator('#export-feedback').innerText(),/12/); await page.locator('#export-dialog [aria-label="关闭导出设置"]').click();
  await exportWith('png'); const png = await bytes(output.png); assert.equal(png.readUInt32BE(16),1920); assert.ok(png.readUInt32BE(20)>800);
  await action('style'); await page.locator('[data-theme="night"]').click(); await page.waitForSelector('.ProseMirror .moye-diagram[data-diagram-theme="night"]');
  await exportWith('plain-html'); const plain = (await bytes(output['plain-html'])).toString();
  const plainState = await page.evaluate(html => { const doc = new DOMParser().parseFromString(html,'text/html'), sized = [...doc.images].find(image => image.alt === '尺寸集成图'); return { styles:doc.querySelectorAll('style,[style]').length, svg:doc.querySelectorAll('svg').length, images:[...doc.images].map(image=>image.src), text:doc.body.textContent, heading:doc.querySelector('h1')?.textContent, numberedAttributes:doc.querySelectorAll('[data-heading-number]').length, sized: sized && { width:sized.width, height:sized.height, title:sized.title } }; },plain);
  assert.equal(plainState.heading, '1 导出验证'); assert.equal(plainState.numberedAttributes, 0);
  assert.deepEqual(plainState.sized, { width:180, height:90, title:'尺寸说明' });
  assert.equal(await fs.readFile(documentPath, 'utf8'), fixture);
  assert.equal(plainState.styles,0); assert.equal(plainState.svg,0); assert.ok(plainState.images.length>=4); assert.ok(plainState.images.every(src=>src.startsWith('data:image/png;base64,'))); assert.match(plainState.text,/正文与行内公式/);
  const sharp = require('sharp'); for (const image of plainState.images) { const buffer=Buffer.from(image.split(',')[1],'base64'); assert.ok((await sharp(buffer).stats()).channels.some(channel=>channel.stdev>0)); await readableInk(buffer); }
  pass('PNG exports the full document; plain HTML from night mode retains dark formula, chemistry and diagram images without CSS');
  await page.locator('.diagram-actions').first().click(); await page.locator('[data-diagram-save="svg"]').click(); await bytes(env.MOYE_TEST_DIAGRAM_SVG_PATH);
  assert.match((await bytes(env.MOYE_TEST_DIAGRAM_SVG_PATH)).toString(),/<svg/);
  await page.locator('.ProseMirror .moye-diagram svg').first().click({button:'right'}); await page.locator('[data-diagram-save="png"]').click();
  await page.waitForTimeout(200); assert.ok((await bytes(env.MOYE_TEST_DIAGRAM_PNG_PATH)).readUInt32BE(16)>100);
  await page.locator('.diagram-actions').first().click(); await page.locator('[data-diagram-save="clipboard"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('已复制图表'));
  assert.ok(await app.evaluate(async ({clipboard})=>(await clipboard.read()).some(item=>item.types.includes('image/png'))));
  pass('diagram compact menu and context menu save standalone SVG/PNG and copy an image');
  await page.locator('[data-mode="source"]').click(); await action('export-options'); await page.locator('#export-kind').selectOption('png');
  await page.locator('#confirm-export').click(); await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(process.platform==='darwin'?'Meta+End':'Control+End'); await page.keyboard.insertText('\n导出过程中新增的文字\n'); await idle();
  assert.match(await page.locator('#source-editor .cm-content').innerText(),/导出过程中新增的文字/); assert.equal(await page.locator('#dirty-dot').isVisible(),true);
  await action('save'); assert.match(await fs.readFile(documentPath,'utf8'),/导出过程中新增的文字/); await page.locator('[data-mode="visual"]').click();
  pass('export uses a snapshot while concurrent typing remains dirty and can be saved');
  const tooLarge = await page.evaluate(async () => { try { await window.moye.exportFile({kind:'png',suggestedName:'large',html:'<div style="height:30000px">超长</div>',pngWidth:960,pngScale:2}); return ''; } catch(error) { return String(error); } });
  assert.match(tooLarge,/20,000/); assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  pass('oversized document images fail clearly and close the temporary rendering window');
  const requests = [], server = createServer((request,response)=>{requests.push(request.url);response.end('outside-resource');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await app.evaluate((_electron,file)=>{process.env.MOYE_TEST_EXPORT_PNG_PATH=file;},path.join(run,'isolated-snapshot.png'));
    await app.evaluate(({app})=>{global.__moyeUnsafeExecuted=false;app.once('browser-window-created',(_event,win)=>win.webContents.on('console-message',(...args)=>{if(args.some(value=>value==='MOYE_UNSAFE_EXECUTED'||value?.message==='MOYE_UNSAFE_EXECUTED'))global.__moyeUnsafeExecuted=true;}));});
    const remote = `http://127.0.0.1:${server.address().port}/resource`;
    await page.evaluate(async remote=>window.moye.exportFile({kind:'png',suggestedName:'security',html:`<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'"><style>body{background-image:url('${remote}')}</style><h1>隔离快照</h1><script>console.log('MOYE_UNSAFE_EXECUTED');fetch('${remote}')</script><iframe src="${remote}"></iframe>`}),remote);
    assert.equal(await app.evaluate(()=>global.__moyeUnsafeExecuted),false); assert.deepEqual(requests,[]);
    const blocked = await page.evaluate(async src=>{try {await window.moye.exportFile({kind:'pdf',suggestedName:'blocked',html:`<img src="${src}">`});return '';}catch(error){return String(error);}},pathToFileURL(output.png).href);
    assert.match(blocked,/无法解码或被阻止/); assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  } finally { await app.evaluate((_electron,file)=>{process.env.MOYE_TEST_EXPORT_PNG_PATH=file;},output.png); await new Promise(resolve=>server.close(resolve)); }
  pass('isolated snapshots block scripts, network/CSS/iframe resources and unauthorized local images, and clean up on failure');
  const tools = await page.evaluate(()=>window.moye.exportTools());
  if(process.env.MOYE_REQUIRE_PANDOC==='1'||process.env.CI==='true') assert.equal(tools.available,true,`CI requires actual Pandoc conversions: ${tools.message}`);
  if (tools.available) {
    await exportWith('docx'); await exportWith('epub');
    for (const kind of ['docx','epub']) {
      const entries = await zipEntries(output[kind]); const media = [...entries].filter(([name])=>/\.(png|jpe?g)$/i.test(name)); assert.ok(media.length >= (kind === 'docx' ? 3 : 5),`${kind}: ${[...entries.keys()]}`);
      for (const [, image] of media) { assert.ok((await sharp(image).stats()).channels.some(channel=>channel.stdev>0)); await readableInk(image); }
      const text = [...entries].filter(([name])=>kind==='docx'?name==='word/document.xml':name.endsWith('.xhtml')).map(([,value])=>value.toString()).join(' '); assert.match(text,/导出验证/); assert.match(text,/正文与行内公式/); assert.ok(!text.includes('must-not-run.lua'));
      assert.match(text.replace(/<[^>]*>/g, ''), /1 导出验证/, `${kind} retains visible section numbers as text`);
      if (kind === 'docx') {
        assert.match(text, /<wp:extent cx="1714500" cy="857250"\s*\/>/, 'Word keeps the 180 × 90 px image size');
        assert.match(text, /<m:oMath[ >]/, 'Word formulas are native OMML');
        assert.match(text, /<m:f>/, 'fractions remain editable instead of becoming pictures');
      }
      else {
        const size = await page.evaluate(html => { const doc = new DOMParser().parseFromString(html, 'text/html'), image = [...doc.images].find(node => node.alt === '尺寸集成图'); return image && { width:image.width, height:image.height, title:image.title }; }, text);
        assert.deepEqual(size, { width:180, height:90, title:'尺寸说明' }, 'EPUB keeps image size and description');
      }
    }
    pass('Pandoc DOCX keeps common formulas editable with complex-math image fallback; EPUB retains readable formula and diagram images');
    const original = await bytes(output.docx); await action('import-document');
    assert.equal(await page.locator('#dirty-dot').isVisible(),true); assert.match(await page.locator('#document-name').innerText(),/\.md$/);
    await action('save'); const imported = await fs.readFile(importedPath,'utf8'); assert.match(imported,/导出验证/); assert.ok((imported.match(/data:image\/png;base64,/g)||[]).length>=3); assert.match(imported, /\\frac/); assert.deepEqual(await bytes(output.docx),original);
    const htmlInput = path.join(run,'import.html'), secret = path.join(run,'private.txt'); await fs.writeFile(secret,'PRIVATE_FILE_MUST_NOT_LEAK');
    await fs.writeFile(htmlInput,`<h1>安全导入</h1><p>普通文字</p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math><script>throw new Error('must-not-run')</script><iframe src="${secret}"></iframe><img src="file://${secret}">`);
    await app.evaluate((_electron,file)=>{process.env.MOYE_TEST_IMPORT_PATH=file;},htmlInput); await action('import-document');
    await page.locator('[data-mode="source"]').click(); const importedHtml = await page.locator('#source-editor .cm-content').innerText(); assert.match(importedHtml,/安全导入/); assert.match(importedHtml,/\$x\$/); assert.ok(!importedHtml.includes('PRIVATE_FILE_MUST_NOT_LEAK')); assert.match(importedHtml,/未导入图片/);
    await app.evaluate((_electron,file)=>{process.env.MOYE_TEST_EXPORT_HTML_PATH=file;},htmlInput);
    const blocked = await page.evaluate(async()=>{try {await window.moye.exportFile({kind:'html',html:'<p>overwrite</p>',suggestedName:'import'}); return ''; } catch(error) {return String(error);} }); assert.match(blocked,/原文件/);
    pass('DOCX and HTML import into new dirty Markdown, retain images/math and never read or overwrite outside resources');
    const nativeWord = path.join(run,'native-equations.docx');
    await new Promise((resolve,reject)=>{const child=execFile(tools.path,['--sandbox','--from=markdown+tex_math_dollars','--to=docx',`--output=${nativeWord}`],{windowsHide:true,timeout:30000},error=>error?reject(error):resolve());child.stdin.end('# Word 原生公式\n\n行内 $x^2$。\n\n$$\\frac{1}{2}$$\n');});
    await app.evaluate((_electron,file)=>{process.env.MOYE_TEST_IMPORT_PATH=file;},nativeWord); await action('import-document');
    const nativeSource=await page.locator('#source-editor .cm-content').innerText(); assert.match(nativeSource,/\$x\^\{?2\}?\$/); assert.match(nativeSource,/\\frac\{1\}\{2\}/);
    await page.locator('[data-mode="visual"]').click(); await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror .moye-math mjx-container[jax="SVG"]').length>=2);
    pass('native Word OMML equations import as editable TeX and render through the same offline math engine');
  } else { skipped.push(`Pandoc conversion: ${tools.message}`); console.log(`SKIP ${skipped.at(-1)}`); await action('export-options'); await page.locator('#export-kind').selectOption('docx'); await page.locator('#confirm-export').click(); assert.equal(await page.locator('#export-dialog').isVisible(),true); }
  assert.deepEqual(errors,[]); pass('no renderer exceptions in the export/import workflow');
} finally {
  if(app) { await page.screenshot({path:path.join(run,'last-state.png'),timeout:5000}).catch(()=>{}); await fs.writeFile(path.join(run,'last-state.json'),JSON.stringify(await page.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,busy:document.body.classList.contains('is-busy'),dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.id)})).catch(()=>null),null,2)); await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); await app.close().catch(()=>{}); }
  await fs.writeFile(path.join(run,'results.json'),JSON.stringify({results,errors,skipped},null,2)); console.log(`Evidence: ${run}`);
}

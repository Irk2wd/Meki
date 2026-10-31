import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'image-hosting-'))), profile = path.join(run, 'profile');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const picture = path.join(run, '原 图.png'), doc = path.join(run, '图床.md'), richDoc = path.join(run, 'Rich.md'), fallbackDoc = path.join(run, '本地后备.md');
const original = '\uFEFF---\r\ntitle: 图床检查\r\n---\r\n# 上传\r\n\r\n![A **alt**](<原 图.png> "Title")\r\n\r\n![引用][shared] [普通链接][shared]\r\n\r\n[shared]: <原 图.png> "Shared title"\r\n\r\n<img src="原 图.png" width="84" height="36" alt="尺寸" title="Keep" />\r\n\r\n```md\r\n![code](missing.png)\r\n```\r\n\r\n![嵌入](data:image/png;base64,' + png.toString('base64') + ')\r\n\r\n![网络](https://images.moye.test/existing.png)\r\n';
await fs.writeFile(picture, png); await fs.writeFile(doc, original);
await fs.writeFile(richDoc, '# Rich\n\n<img src="原 图.png" width="84" height="36" alt="Rich image" title="Keep">\n');
await fs.mkdir(profile);
const requests = [], uploads = []; let mode = 'success', delay = 0, afterRead;
const server = http.createServer(async (request, response) => {
  try {
  let data = ''; for await (const chunk of request) data += chunk;
  requests.push({ path: request.url, method: request.method, data });
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/heartbeat') { response.end(JSON.stringify({ success: true, result: 'alive' })); return; }
  if (request.url !== '/upload') { response.writeHead(404).end(); return; }
  const { list } = JSON.parse(data); assert.ok(Array.isArray(list) && list.length > 0);
  const bytes = await Promise.all(list.map(file => fs.readFile(file)));
  for (const value of bytes) { assert.deepEqual(value.subarray(0, 8), png.subarray(0, 8)); assert.equal(value.readUInt32BE(16), 1); assert.equal(value.readUInt32BE(20), 1); }
  uploads.push({ list, bytes }); if (afterRead) await afterRead();
  const outcome = mode; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (response.destroyed) return;
  const urls = list.map((_file, index) => `https://images.moye.test/upload-${uploads.length}-${index}.png?token=test&size=original`);
  response.end(JSON.stringify(outcome === 'failure' ? { success: false, message: 'provider secret should not be rendered' } : { success: true, result: outcome === 'partial' ? urls.slice(1) : urls }));
  } catch (error) { errors.push(error.message); if (!response.destroyed) response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'cancel', MOYE_TEST_CONFLICT: 'cancel', MOYE_TEST_SAVE_PATH: fallbackDoc, MOYE_TEST_IMAGE_PATHS: JSON.stringify([picture]) }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End', redo = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';
let app, page; const results = [], errors = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function poll(check) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error('Timed out waiting for image hosting result'); }
async function session() { try { return JSON.parse(await fs.readFile(path.join(profile, 'session.json'), 'utf8')); } catch { return null; } }
async function content(file, predicate) { return poll(async () => { const value = (await session())?.documents.find(item => item.path === file)?.content; return value !== undefined && predicate(value) ? value : null; }); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); }
async function source() { await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content'); }
async function preview(native = false) {
  await idle();
  if (native) await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === '上传文稿图片…').click());
  else { await action('image-hosting'); await page.locator('[data-host="upload"]').click(); }
  await page.locator('#image-upload-dialog').waitFor({ state: 'visible' });
}
async function confirm() { await page.locator('[data-upload="confirm"]').click(); await page.locator('#image-upload-dialog').waitFor({ state: 'hidden' }); await idle(); }
async function close() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function launch(args = ['--open', doc]) {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.route('https://images.moye.test/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
  await page.waitForSelector('#shell[data-ready="true"]');
}
try {
  await launch(); assert.equal(requests.length, 0);
  await action('image-hosting'); assert.equal(await page.locator('#image-auto-upload').isChecked(), false);
  assert.equal(await page.locator('#picgo-port').inputValue(), '36677'); await page.locator('#picgo-port').fill(String(port));
  await page.locator('[data-host="check"]').click();
  await poll(() => requests.some(item => item.path === '/heartbeat'));
  await page.waitForFunction(() => !document.querySelector('[data-host="check"]').disabled);
  assert.equal(uploads.length, 0); assert.equal(requests[0].method, 'POST');
  const denied = await page.evaluate(async bytes => { try { await window.moye.uploadImages([{ name: 'test.png', bytes: new Uint8Array(bytes) }]); return ''; } catch (error) { return String(error); } }, [...png]);
  assert.match(denied, /尚未开启/); assert.equal(uploads.length, 0);
  await page.screenshot({ path: path.join(run, 'picgo-settings.png') });
  await page.locator('[data-host="close"]').click();
  pass('PicGo is opt-in; toolbar settings persist a local port and the heartbeat checks connectivity without uploading clipboard data');

  const sourceEditor = await source(); await sourceEditor.click(); await page.keyboard.press(end); await page.keyboard.insertText('\n未保存的正文');
  const before = await content(doc, text => text.includes('未保存的正文'));
  await preview(); assert.match(await page.locator('#image-upload-summary').innerText(), /2 张不同图片/); assert.match(await page.locator('#image-upload-summary').innerText(), /1 个网络/);
  await page.screenshot({ path: path.join(run, 'upload-preview.png') });
  await page.locator('#image-upload-dialog .dialog-actions [data-upload="cancel"]').click(); await idle();
  assert.equal(uploads.length, 0); assert.equal(await fs.readFile(doc, 'utf8'), original); assert.equal(await content(doc, text => text === before), before);
  pass('manual preview deduplicates local and embedded images, skips remote URLs and cancels without uploading or changing document bytes');

  await preview(true); await confirm(); const uploaded = await content(doc, text => text.includes('upload-1-') && !text.includes('data:image'));
  assert.equal(uploads[0].list.length, 2); assert.ok(uploads[0].list.every(file => path.isAbsolute(file) && file !== picture));
  uploads[0].bytes.forEach(bytes => assert.deepEqual(bytes, png));
  assert.ok(uploaded.includes('![A **alt**](<https://images.moye.test/')); assert.ok(uploaded.includes('"Title"'));
  assert.ok(uploaded.includes('[普通链接][shared]')); assert.ok(uploaded.includes('[shared]: <原 图.png> "Shared title"'));
  assert.ok(uploaded.includes('width="84" height="36" alt="尺寸" title="Keep"')); assert.ok(uploaded.includes('![code](missing.png)')); assert.ok(uploaded.includes('![网络](https://images.moye.test/existing.png)'));
  assert.deepEqual(await fs.readFile(picture), png); assert.equal(await fs.readFile(doc, 'utf8'), original);
  assert.equal((await session()).documents.find(item => item.path === doc).paused, 'attachments');
  await sourceEditor.click(); await page.keyboard.press(`${mod}+z`); await content(doc, text => text === before);
  await page.keyboard.press(redo); await content(doc, text => text === uploaded);
  pass('successful upload replaces only image destinations, preserves Markdown and image sizing, pauses autosave and supports grouped undo/redo');

  await close(); await launch(); await source(); await content(doc, text => text === uploaded);
  await action('image-hosting'); assert.equal(await page.locator('#picgo-port').inputValue(), String(port)); await page.locator('[data-host="close"]').click();
  await action('save'); await poll(async () => (await fs.readFile(doc, 'utf8')).includes('upload-1-')); await idle();
  const saved = await fs.readFile(doc, 'utf8'); assert.ok(saved.startsWith('\uFEFF---\r\n')); assert.equal(/(?<!\r)\n/.test(saved), false);
  pass('crash recovery keeps uploaded references and PicGo preferences; manual saving preserves BOM and CRLF');

  await app.evaluate((_electron, file) => { process.env.MOYE_TEST_OPEN_PATH = file; }, richDoc); await action('open');
  await page.waitForFunction(file => document.querySelector('#document-name').title === file, richDoc);
  await preview(); mode = 'partial'; await confirm();
  assert.match(await page.locator('#toast').innerText(), /PicGo|返回|上传/); assert.equal((await fs.readFile(richDoc, 'utf8')).includes('upload-'), false);
  mode = 'success'; delay = 500; await preview(); await page.locator('[data-upload="confirm"]').click();
  await poll(() => uploads.length >= 3); await page.locator('#image-upload-dialog .dialog-actions [data-upload="cancel"]').click();
  await page.locator('#image-upload-dialog').waitFor({ state: 'hidden' }); await idle(); delay = 0;
  const richBefore = await fs.readFile(richDoc, 'utf8');
  afterRead = async () => fs.writeFile(richDoc, `${richBefore}\n外部变化`); await preview(); await confirm(); afterRead = undefined;
  assert.ok((await fs.readFile(richDoc, 'utf8')).includes('外部变化')); assert.equal((await page.locator('.ProseMirror img[alt="Rich image"]').getAttribute('src')).includes('upload-'), false);
  await fs.writeFile(richDoc, richBefore);
  pass('partial responses, cancellation and external document changes never replace original image references');

  await preview(); await confirm();
  await page.waitForFunction(() => { const image = document.querySelector('.ProseMirror img[alt="Rich image"]'); return image && image.src.includes('upload-') && image.width === 84 && image.height === 36 && image.title === 'Keep'; });
  await page.locator('.ProseMirror').click(); await page.keyboard.press(`${mod}+z`);
  await page.waitForFunction(() => !document.querySelector('.ProseMirror img[alt="Rich image"]').src.includes('upload-'));
  pass('visual-mode upload and undo keep image dimensions and title');

  await action('image-hosting'); await page.locator('#image-auto-upload').check(); await page.locator('[data-host="save"]').click();
  await page.waitForFunction(() => document.querySelector('#image-host-status').textContent === '设置已保存。'); await page.locator('[data-host="close"]').click();
  await action('new'); await page.waitForFunction(() => document.querySelector('#document-name').title === '尚未保存到文件');
  await page.locator('.ProseMirror').click(); await page.keyboard.insertText('新的图文稿'); await action('image');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已通过 PicGo 上传并添加')); await idle();
  assert.equal(await page.locator('#document-name').getAttribute('title'), '尚未保存到文件');
  assert.ok((await page.locator('.ProseMirror img').getAttribute('src')).includes('upload-'));
  pass('opt-in automatic upload inserts remote images into an untitled document without requiring a local Save As');

  const rich = page.locator('.ProseMirror'); await rich.locator(':scope > p').last().click(); await page.keyboard.press(end);
  await app.evaluate(({ clipboard, ClipboardItem, nativeImage }, file) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([nativeImage.createFromPath(file).toPNG()], { type: 'image/png' }) })]), picture);
  const pasteCount = uploads.length; await page.keyboard.press(`${mod}+v`);
  await poll(() => uploads.length > pasteCount); await page.waitForFunction(() => document.querySelectorAll('.ProseMirror img').length === 2); await idle();
  await source(); const sourceArea = page.locator('#source-editor .cm-content'); await sourceArea.click(); await page.keyboard.press(end);
  const dropCount = uploads.length;
  await page.locator('#document-scroll').evaluate((target, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], '拖入.png', { type: 'image/png' }));
    const box = target.getBoundingClientRect(); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: box.left + 100, clientY: box.top + 80 }));
  }, [...png]);
  await poll(() => uploads.length > dropCount); await page.waitForFunction(() => (document.querySelector('#source-editor .cm-content').textContent.match(/!\[/g) || []).length === 3); await idle();
  pass('real clipboard paste in visual mode and file drop in source mode use the enabled PicGo uploader');

  mode = 'failure'; await source(); const cm = page.locator('#source-editor .cm-content'); await cm.click(); await page.keyboard.press(end); await action('image');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已改为本地附件')); await idle();
  assert.equal(await page.locator('#document-name').getAttribute('title'), fallbackDoc); assert.match(await cm.innerText(), /\.assets\//);
  assert.equal((await fs.readdir(path.join(run, '本地后备.assets'))).length, 1);
  assert.equal((await page.locator('#toast').innerText()).includes('provider secret'), false);
  assert.deepEqual(await fs.readFile(picture), png); assert.deepEqual(errors, []);
  pass('automatic upload failure falls back to local attachments and the normal save flow without losing the image or exposing provider output');

  mode = 'success'; delay = 500; const cancelCount = uploads.length;
  await cm.click(); await page.keyboard.press(end); await action('image'); await page.locator('#image-insert-upload').waitFor({ state: 'visible' });
  await poll(() => uploads.length > cancelCount); await page.locator('#image-insert-upload button').click();
  await poll(async () => (await fs.readdir(path.join(run, '本地后备.assets'))).length === 2); await idle(); delay = 0;
  assert.equal((await cm.innerText().then(text => text.match(/\.assets\//g)))?.length, 2);
  await action('image-hosting'); assert.equal(await page.locator('#image-auto-upload').isChecked(), true);
  assert.deepEqual(errors, []); pass('canceling automatic upload stops waiting and inserts a local attachment while keeping the opt-in setting');
} finally {
  if (page) await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  await close(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

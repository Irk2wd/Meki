import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'image-management-'))), profile = path.join(run, 'profile');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const picture = path.join(run, '原 图.png'), other = path.join(run, 'other.png'), doc = path.join(run, '图片管理.md');
const errors = [], results = [], uploads = []; let delay = 0, downloads = 0, afterDownload;
const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      downloads++; if (afterDownload) await afterDownload();
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (!response.destroyed) { response.setHeader('Content-Type', 'image/png'); response.end(png); }
      return;
    }
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/heartbeat') { response.end(JSON.stringify({ success: true, result: 'alive' })); return; }
    assert.equal(request.url, '/upload'); const { list } = JSON.parse(body);
    uploads.push(list); for (const file of list) assert.deepEqual(await fs.readFile(file), png);
    response.end(JSON.stringify({ success: true, result: list.map((_, index) => `https://images.meki.test/selected-${uploads.length}-${index}.png`) }));
  } catch (error) { errors.push(error.message); if (!response.destroyed) response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, remote = `http://127.0.0.1:${port}/remote.png?size=original`;
const original = '\uFEFF# 图片管理\r\n\r\n<img src="原 图.png" width="84" height="36" alt="原图" title="Keep" />\r\n\r\n![重复](<原 图.png> "Same")\r\n\r\n<img src="other.png" width="84" height="36" alt="其他" />\r\n\r\n<img src="' + remote + '" width="84" height="36" alt="网络" />\r\n';
await fs.writeFile(picture, png); await fs.writeFile(other, png); await fs.writeFile(doc, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_DISCARD: 'cancel', MEKI_TEST_CONFLICT: 'cancel', MEKI_TEST_FOLDER_PATH: run, MEKI_TEST_IMAGE_DOWNLOAD_ORIGIN: `http://127.0.0.1:${port}` }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', redo = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';
let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function poll(check) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error('Timed out waiting for image operation'); }
async function session() { try { return JSON.parse(await fs.readFile(path.join(profile, 'windows-v1.json'), 'utf8')).windows[0].session; } catch { return null; } }
async function content(predicate) { return poll(async () => { const value = (await session())?.documents.find(item => item.path === doc)?.content; return value !== undefined && predicate(value) ? value : null; }); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); }
async function imageAction(alt, actionName) {
  const image = page.locator(`.ProseMirror img[alt="${alt}"]`); await image.scrollIntoViewIfNeeded();
  const box = await image.boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + box.width - 2, box.y + box.height - 2, { button: 'right' });
  await page.locator('#image-actions-menu').waitFor({ state: 'visible' });
  await page.locator(`[data-image-action="${actionName}"]`).click();
}
async function copyOptions(directory, name = '') {
  await page.locator('#image-copy-dialog').waitFor({ state: 'visible' });
  await page.locator('#image-copy-base').selectOption('document');
  await page.locator('#image-copy-directory').fill(directory); await page.locator('#image-copy-name').fill(name);
  await page.locator('#image-copy-dialog button[type="submit"]').click();
}
async function complete() { await page.locator('#image-copy-dialog').waitFor({ state: 'hidden' }); await idle(); }
async function undo() {
  await idle();
  // The editor's center can hit an image caption; focus document text before undo.
  await page.locator('.ProseMirror h1').click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.press(`${mod}+z`);
}
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', doc] : [root, '--open', doc], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.route('https://images.meki.test/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 694); window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]');
  await action('image-hosting'); await page.locator('#picgo-port').fill(String(port));
  await page.locator('#image-directory').fill('images/${filename}'); await page.locator('[data-host="save"]').click();
  await page.waitForFunction(() => document.querySelector('#image-host-status').textContent === '设置已保存。');
  await page.locator('[data-host="close"]').click();
  await action('image-hosting'); assert.equal(await page.locator('#image-directory').inputValue(), 'images/${filename}'); await page.locator('[data-host="close"]').click();
  pass('image directory preference is persisted without enabling automatic uploads');

  // The compatibility copy can fail independently of the authoritative session.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises'); globalThis.imageTestRename = fs.rename; globalThis.imageLegacyFailures = 0;
    fs.rename = async (...args) => {
      if (String(args[1]).endsWith('session.json')) { globalThis.imageLegacyFailures++; throw Error('image-test-legacy-write-failure'); }
      return globalThis.imageTestRename(...args);
    };
  });
  await imageAction('原图', 'copy'); assert.equal(await page.locator('#image-copy-directory').inputValue(), 'images/${filename}');
  await copyOptions('images/copies', '副本.png'); await complete();
  let copied = await content(text => text.includes('images/copies/'));
  assert.equal((copied.match(/images\/copies\//g) || []).length, 2);
  assert.ok(copied.includes('width="84" height="36" alt="原图" title="Keep"')); assert.ok(copied.includes('src="other.png"'));
  assert.deepEqual(await fs.readFile(path.join(run, 'images/copies/副本.png')), png);
  assert.deepEqual(await fs.readFile(picture), png); assert.equal(await fs.readFile(doc, 'utf8'), original);
  assert.equal((await session()).documents.find(item => item.path === doc).paused, 'attachments');
  assert.ok(await app.evaluate(() => globalThis.imageLegacyFailures > 0));
  await app.evaluate(() => { process.getBuiltinModule('node:fs/promises').rename = globalThis.imageTestRename; delete globalThis.imageTestRename; delete globalThis.imageLegacyFailures; });
  await undo(); await content(text => !text.includes('images/copies/'));
  await page.keyboard.press(redo); copied = await content(text => text.includes('images/copies/'));
  assert.equal((copied.match(/images\/copies\//g) || []).length, 2);
  pass('right-click named copy durably updates matching references despite a failed legacy copy, preserves originals and supports undo/redo');

  await imageAction('其他', 'upload'); await page.locator('#image-upload-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#image-upload-summary').innerText(), /1 张不同图片/);
  await page.locator('[data-upload="confirm"]').click(); await page.locator('#image-upload-dialog').waitFor({ state: 'hidden' }); await idle();
  const uploaded = await content(text => text.includes('selected-1-0.png'));
  assert.equal(uploads[0].length, 1); assert.ok(uploaded.includes('images/copies/')); assert.ok(uploaded.includes(remote));
  await undo(); await content(text => text === copied);
  pass('single-image PicGo action uploads only the selected source and supports undo');

  await imageAction('网络', 'download'); await copyOptions('downloaded', '本地网络.png'); await complete();
  const localized = await content(text => text.includes('downloaded/'));
  assert.ok(!localized.includes(remote)); assert.ok(!localized.includes('size=original'));
  assert.deepEqual(await fs.readFile(path.join(run, 'downloaded/本地网络.png')), png);
  await undo(); await content(text => text === copied);
  pass('selected remote image downloads through the bounded main-process request and updates only its references');

  delay = 1200; let beforeCount = downloads;
  await imageAction('网络', 'download'); await copyOptions('cancelled', 'cancelled.png');
  await poll(() => downloads > beforeCount); await page.locator('#image-copy-dialog .dialog-actions [data-image-cancel]').click(); await complete();
  assert.equal(await content(text => text === copied), copied); await assert.rejects(fs.stat(path.join(run, 'cancelled')), { code: 'ENOENT' });
  pass('cancel interrupts a pending image download without creating a directory or changing references');

  afterDownload = async () => fs.writeFile(doc, `${original}\r\n外部变化`);
  await imageAction('网络', 'download'); await copyOptions('conflicted', 'conflicted.png');
  await page.waitForFunction(() => document.querySelector('#image-copy-status').textContent.includes('其他程序修改')); await idle();
  afterDownload = undefined; delay = 0;
  await assert.rejects(fs.stat(path.join(run, 'conflicted')), { code: 'ENOENT' }); assert.equal(await content(text => text === copied), copied);
  await page.locator('#image-copy-dialog .dialog-actions [data-image-cancel]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 660));
  const firstBlock = page.locator('.meki-image-block').filter({ has: page.locator('img[alt="原图"]') });
  await firstBlock.hover(); await firstBlock.locator('.image-more-actions').click();
  await page.locator('[data-image-action="copy"]').click();
  const layout = await page.locator('#image-copy-dialog').evaluate(dialog => { const b = dialog.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: innerWidth, height: innerHeight }; });
  assert.ok(layout.x >= 0 && layout.y >= 0 && layout.right <= layout.width && layout.bottom <= layout.height);
  await page.screenshot({ path: path.join(run, 'image-copy-dialog.png') });
  await page.locator('#image-copy-dialog .dialog-actions [data-image-cancel]').click();
  assert.deepEqual(errors, []);
  pass('external edits reject reference replacement; the image dialog fits a narrow window with no renderer errors');
} finally {
  if (page) await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

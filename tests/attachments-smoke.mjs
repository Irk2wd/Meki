import { readSession } from './recovery-fixture.cjs';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'attachments-')));
const folder = path.join(run, 'documents'), images = path.join(folder, 'images'), profile = path.join(run, 'profile');
await fs.mkdir(images, { recursive: true }); await fs.mkdir(profile);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const picture = path.join(images, '原 图.png'), doc = path.join(folder, '附件.md'), other = path.join(folder, 'Other.md'), rich = path.join(folder, 'Rich.md'), target = path.join(folder, '附件.assets');
const original = '\uFEFF---\r\ntitle: 图片整理\r\n---\r\n![A **alt**](<images/原 图.png?size=1#crop> "Title")\r\n\r\n![引用][shared] [普通链接][shared]\r\n\r\n[shared]: <images/原 图.png> "Shared title"\r\n\r\n<img src="images/原 图.png" width="240" height="160" alt="尺寸" title="Keep" />\r\n\r\n```md\r\n![code](missing.png)\r\n```\r\n\r\n![嵌入](data:image/png;base64,' + png.toString('base64') + ')\r\n\r\n![网络](https://example.invalid/remote.png)\r\n';
const richOriginal = '# Rich\n\n<img src="images/原 图.png" alt="Rich image" title="Rich title" width="80" height="60">\n';
await fs.writeFile(picture, png); await fs.writeFile(doc, original); await fs.writeFile(other, '# Other\n'); await fs.writeFile(rich, richOriginal);
// Keep the initial unsaved fixture stable while testing preview/cancel. Auto-save
// remains enabled so the later attachment pause is still checked explicitly.
await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ workspaceRoot: folder, settings: { autoSave: true, autoSaveInterval: 600, autoSaveOnBlur: false } }));
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_DISCARD: 'cancel', MEKI_TEST_CONFLICT: 'cancel' }; delete env.ELECTRON_RUN_AS_NODE;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End', redo = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';
const results = [], errors = []; let app, page;
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.evaluate(name => document.querySelector(`[data-action="${name}"]`).click(), name); await idle(); }
async function open(file) { await app.evaluate((_electron, file) => { process.env.MEKI_TEST_OPEN_PATH = file; }, file); await action('open'); }
async function tab(file) { await page.locator('.document-tab [role="tab"]').evaluateAll((nodes, file) => nodes.find(node => node.title === file).click(), file); await idle(); }
async function source() { await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content'); }
async function poll(check, timeout = 12000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); } throw Error('Timed out waiting for attachment state'); }
async function savedSession() { try { return await readSession(profile); } catch { return null; } }
async function content(file, predicate) { return poll(async () => { const item = (await savedSession())?.documents.find(item => item.path === file); return item && predicate(item.content) ? item.content : null; }); }
async function organizer(native = false) {
  if (native) await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items.find(item => item.label === '整理图片附件…').click());
  else { await action('lifecycle-settings'); await page.evaluate(() => document.querySelector('[data-action="organize-attachments"]').click()); }
  await page.locator('#attachment-dialog').waitFor({ state: 'visible' });
}
async function cancel() { await page.locator('#attachment-dialog .dialog-actions [value="cancel"]').click(); await idle(); }
async function confirm() { await page.locator('#attachment-confirm').click(); await idle(); }
async function launch(args = []) {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? args : [root, ...args], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show()); await page.waitForSelector('#shell[data-ready="true"]');
}
async function crash() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }

try {
  await launch(['--open', doc]);
  const sourceEditor = await source(); await sourceEditor.click(); await page.keyboard.press(end); await page.keyboard.insertText('\n尚未保存的正文');
  const before = await content(doc, text => text.includes('尚未保存的正文'));
  await organizer(); assert.match(await page.locator('#attachment-summary').innerText(), /复制 2 张/); assert.match(await page.locator('#attachment-details').innerText(), /1 个网络地址跳过/);
  assert.equal(await page.locator('#attachment-target').innerText(), target); assert.equal(await page.locator('#document-scroll').evaluate(node => Boolean(node.closest('[inert]'))), true);
  const tabs = await page.locator('.document-tab').count(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('meki:command', 'new')); assert.equal(await page.locator('.document-tab').count(), tabs);
  await page.screenshot({ path: path.join(run, 'preview.png'), animations: 'disabled' }); await cancel();
  await assert.rejects(fs.stat(target), { code: 'ENOENT' }); assert.equal(await fs.readFile(doc, 'utf8'), original); assert.equal(await content(doc, text => text === before), before);
  pass('preview uses unsaved content, deduplicates images, shows destination and cancels without mutation; modal blocks document switches');

  await organizer(true); await fs.writeFile(picture, Buffer.concat([png, Buffer.from('external change')])); await confirm();
  assert.match(await page.locator('#toast').innerText(), /图片在预览后已变化/); await assert.rejects(fs.stat(target), { code: 'ENOENT' }); assert.equal(await content(doc, text => text === before), before); await fs.writeFile(picture, png);
  await organizer(); await fs.writeFile(doc, 'External document change'); await confirm(); assert.match(await page.locator('#toast').innerText(), /其他程序修改/); assert.equal(await fs.readFile(doc, 'utf8'), 'External document change'); await fs.writeFile(doc, original);
  pass('native menu opens the organizer; external image and document changes reject confirmation without replacing the editor or originals');

  await organizer(); await confirm();
  const organized = await content(doc, text => text.includes('.assets/') && !text.includes('data:image/png;base64,'));
  assert.equal((await fs.readdir(target)).length, 2); assert.deepEqual(await fs.readFile(picture), png); assert.equal(await fs.readFile(doc, 'utf8'), original);
  assert.ok(organized.includes('![A **alt**](<')); assert.ok(organized.includes('?size=1#crop> "Title")')); assert.ok(organized.includes('[普通链接][shared]')); assert.ok(organized.includes('[shared]: <images/原 图.png> "Shared title"'));
  assert.ok(organized.includes('width="240" height="160" alt="尺寸" title="Keep"')); assert.ok(organized.includes('![code](missing.png)')); assert.ok(organized.includes('![网络](https://example.invalid/remote.png)')); assert.ok(organized.includes('尚未保存的正文'));
  assert.match(await page.locator('#document-state').innerText(), /图片引用已整理/); assert.equal((await savedSession()).documents.find(item => item.path === doc).paused, 'attachments');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('meki:command', 'autosave')); await idle(); assert.equal(await fs.readFile(doc, 'utf8'), original);
  pass('confirmation copies unique images and changes only image tokens, retaining alt/title/dimensions/code/links; autosave stays paused');

  await sourceEditor.click(); await page.keyboard.press(`${modifier}+z`); assert.equal(await content(doc, text => text === before), before); assert.equal((await fs.readdir(target)).length, 2);
  await page.keyboard.press(redo); assert.equal(await content(doc, text => text === organized), organized);
  await open(other); await tab(doc); await source(); assert.equal(await content(doc, text => text === organized), organized);
  pass('source undo/redo groups the entire relocation and tab switches retain dirty content and attachments');

  await crash(); await launch(); await tab(doc); await source();
  assert.equal(await content(doc, text => text === organized), organized); assert.equal((await fs.readdir(target)).length, 2); assert.match(await page.locator('#document-state').innerText(), /图片引用已整理/); assert.equal(await fs.readFile(doc, 'utf8'), original);
  await action('save'); const saved = await fs.readFile(doc, 'utf8'); assert.ok(saved.startsWith('\uFEFF---\r\n')); assert.equal(saved.slice(1).replace(/\r\n/g, '\n'), organized.replace(/\r\n/g, '\n')); assert.equal(/(?<!\r)\n/.test(saved), false);
  await organizer(); assert.match(await page.locator('#attachment-summary').innerText(), /复制 0 张/); await confirm(); assert.equal((await fs.readdir(target)).length, 2);
  pass('crash recovery retains attachment references and paused state; manual save preserves BOM/CRLF and repeated organization reuses copies');

  await open(rich); assert.equal(await page.locator('#visual-editor').isVisible(), true); await organizer(); await confirm();
  await page.waitForFunction(() => { const image = document.querySelector('.ProseMirror img[alt="Rich image"]'), box = image?.getBoundingClientRect(); return image?.naturalWidth === 1 && box?.width === 80 && box?.height === 60 && image.title === 'Rich title'; });
  await content(rich, text => text.includes('Rich.assets/')); await page.locator('.ProseMirror').click(); await page.keyboard.press(`${modifier}+z`);
  await content(rich, text => !text.includes('Rich.assets/') && text.includes('images/原 图.png')); assert.equal(await fs.readFile(rich, 'utf8'), richOriginal); assert.equal((await fs.readdir(path.join(folder, 'Rich.assets'))).length, 1);
  assert.deepEqual(await page.locator('.ProseMirror img[alt="Rich image"]').evaluate(image => ({ width:image.width, height:image.height, title:image.title })), { width:80, height:60, title:'Rich title' });
  pass('visual editing and rich undo preserve sized image dimensions and descriptions without deleting copied files');

  await action('new'); await page.evaluate(() => document.querySelector('[data-action="organize-attachments"]').click()); await idle(); assert.match(await page.locator('#toast').innerText(), /先保存/);
  const denied = await page.evaluate(async () => { const checks = []; for (const input of [{ documentPath: '/unauthorized.md', revision: 'a'.repeat(64), sources: [] }, { documentPath: null, revision: null, sources: [] }]) { try { await window.meki.prepareAttachments(input); checks.push(false); } catch { checks.push(true); } } try { await window.meki.commitAttachments('not-a-plan'); checks.push(false); } catch { checks.push(true); } return checks; });
  assert.deepEqual(denied, [true, true, true]); assert.deepEqual(errors, []); pass('unsaved documents and invalid IPC capabilities are rejected; no renderer exceptions');
} finally {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png'), animations: 'disabled', timeout: 5000 }).catch(() => {}); await fs.writeFile(path.join(run, 'last-dom.html'), await page.content().catch(() => '')); }
  await crash(); await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); console.log(`Evidence: ${run}`);
}

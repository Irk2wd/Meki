import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const run = path.join(root, 'test-results', `image-sizing-${Date.now()}`); await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '图片尺寸.md'), htmlPath = path.join(run, 'image-sizing.html'), pdfPath = path.join(run, 'image-sizing.pdf');
await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c75146' } }).png().toFile(path.join(run, 'photo.png'));
await sharp({ create: { width: 100, height: 60, channels: 3, background: '#386cb0' } }).png().toFile(path.join(run, 'normal.png'));
const original = '\uFEFF' + ['---', 'title: Original metadata', '---', '', '# 图片尺寸', '', '![说明 & words](photo.png "Original title")', '', '![普通图片](normal.png "Keep title")', '', '<img src="photo.png" alt="限定图片" title="Explicit" width="180" height="90">', '', '<img src="normal.png" width="40" onerror="window.__imageExecuted=true">', '', 'After images.', ''].join('\r\n');
await fs.writeFile(documentPath, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKI_TEST_OPEN_PATH: documentPath, MEKI_TEST_EXPORT_HTML_PATH: htmlPath, MEKI_TEST_EXPORT_PDF_PATH: pdfPath, MEKI_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = []; let app, page;
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
async function launch() {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', documentPath] : [root, '--open', documentPath], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.stack || error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
  await page.locator('[data-mode="visual"]').click();
  await page.waitForFunction(() => { const images = [...document.querySelectorAll('.ProseMirror img')]; return images.length === 3 && images.every(image => image.naturalWidth > 0); });
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function command(name) { await page.locator('#format-menu-button').click(); await page.locator(`[data-edit-command="${name}"]`).click(); }
const images = () => page.locator('.ProseMirror .milkdown-image-block img');
async function sized(width) { await page.waitForFunction(width => { const image = document.querySelector('.ProseMirror .milkdown-image-block img'), box = image.getBoundingClientRect(); return image.getAttribute('width') === String(width) && Math.abs(box.width - width) < 1 && Math.abs(box.height - width * .75) < 1; }, width); }
async function save() { await action('save'); return fs.readFile(documentPath, 'utf8'); }
try {
  await launch(); assert.equal(await images().first().getAttribute('width'), null);
  assert.ok(Math.abs((await images().nth(1).boundingBox()).width - 100) < 1);
  assert.equal(await images().nth(2).getAttribute('width'), '180');
  assert.ok(Math.abs((await images().nth(2).boundingBox()).width - 180) < 1);
  assert.ok(Math.abs((await images().nth(2).boundingBox()).height - 90) < 1);
  assert.equal(await page.locator('.meki-raw-html').count(), 1); assert.equal(await page.evaluate(() => window.__imageExecuted), undefined);
  assert.equal(await save(), original);
  pass('safe standalone image dimensions render while unsupported HTML stays inert and untouched bytes are preserved');

  const bitmap = images().first(); await bitmap.locator('..').hover();
  const box = await bitmap.boundingBox(), handle = await page.locator('.image-resize-handle').first().boundingBox();
  const delta = -240, width = Math.round((box.height + delta) * box.width / box.height);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + delta, { steps: 6 }); await page.mouse.up();
  await sized(width); let saved = await save();
  assert.ok(saved.includes(`<img src="photo.png" alt="说明 &amp; words" title="Original title" width="${width}">`));
  assert.ok(saved.includes('![普通图片](normal.png "Keep title")')); assert.ok(saved.startsWith('\uFEFF---\r\ntitle: Original metadata\r\n---\r\n'));
  pass('actual pointer resize followed by immediate Save persists pixel width without replacing alt, title or ordinary Markdown images');

  await command('undo'); assert.equal(await images().first().getAttribute('width'), null); assert.ok((await save()).includes('![说明 & words](photo.png "Original title")'));
  await command('redo'); await sized(width); await save();
  await images().first().locator('..').hover(); await page.locator('.meki-image-reset').first().click(); assert.equal(await images().first().getAttribute('width'), null);
  assert.ok((await save()).includes('![说明 & words](photo.png "Original title")'));
  await command('undo'); await sized(width); await save();
  pass('resizing and restoring original dimensions are individual undo steps and reset returns to standard Markdown syntax');

  await images().first().locator('..').click();
  await page.waitForFunction(() => document.querySelector('.ProseMirror .milkdown-image-block')?.classList.contains('selected'));
  await page.keyboard.press(`${mod}+c`);
  const copied = await app.evaluate(async ({ clipboard }) => { const items = await clipboard.read(); const html = items.find(item => item.types.includes('text/html')); return html ? (await html.getType('text/html')).text() : ''; });
  assert.ok(copied.includes(`width="${width}"`)); assert.ok(copied.includes('alt="说明 &amp; words"')); assert.ok(copied.includes('title="Original title"'));
  await page.locator('.ProseMirror > p').filter({ hasText: 'After images.' }).click();
  await page.waitForFunction(() => {
    const selection = getSelection(), node = selection?.anchorNode;
    // Paste uses the model selection. The image view must have relinquished
    // its node selection, not merely the browser's visible selection range.
    return !document.querySelector('.milkdown-image-block.selected') && selection?.isCollapsed
      && (node instanceof Element ? node : node?.parentElement)?.closest('p')?.textContent === 'After images.';
  });
  await page.keyboard.press(`${mod}+v`);
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .milkdown-image-block img').length === 4);
  const copies = images().and(page.locator(`[width="${width}"]`)); assert.equal(await copies.count(), 2);
  for (const copy of await copies.all()) { assert.equal(await copy.getAttribute('alt'), '说明 & words'); assert.equal(await copy.getAttribute('title'), 'Original title'); }
  await command('undo'); await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .milkdown-image-block img').length === 3);
  pass('copying and pasting an image preserves pixel dimensions, description and title in the editor');

  await images().first().locator('..').hover(); const cancelHandle = await page.locator('.image-resize-handle').first().boundingBox();
  await page.mouse.move(cancelHandle.x + cancelHandle.width / 2, cancelHandle.y + cancelHandle.height / 2); await page.mouse.down();
  await page.mouse.move(cancelHandle.x + cancelHandle.width / 2, cancelHandle.y + cancelHandle.height / 2 + 30);
  await page.keyboard.press(`${mod}+/`); await page.mouse.up(); await page.locator('[data-mode="visual"]').click(); await sized(width);
  pass('switching to source during an unfinished drag cancels the resize without changing hidden editor content');

  await page.locator('[data-mode="source"]').click();
  // Focus the caption in the same frame as the mode switch, before deferred
  // editor focus runs. It must respect the user's newly chosen input target.
  await page.locator('[data-mode="visual"]').evaluate(button => {
    button.click(); document.querySelector('.caption-input').focus();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.caption-input').first().evaluate(input => document.activeElement === input), true, 'mode switching must not steal caption focus');
  await page.locator('.caption-input').first().fill('Updated title & "safe"'); await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !document.body.classList.contains('is-busy')); saved = await fs.readFile(documentPath, 'utf8');
  assert.ok(saved.includes('title="Updated title &amp; &quot;safe&quot;"')); assert.equal(await images().first().getAttribute('alt'), '说明 & words');
  await page.locator('[data-mode="source"]').click(); const source = page.locator('#source-editor .cm-content'), content = await source.innerText();
  assert.ok(content.includes(`width="${width}"`)); await page.locator('[data-mode="visual"]').click(); await sized(width);
  await page.locator('[data-mode="source"]').click(); await source.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(content + '\n\nSource edit.');
  await page.locator('[data-mode="visual"]').click(); await sized(width); saved = await save();
  assert.ok(saved.includes('Source edit.')); assert.ok(saved.includes('onerror="window.__imageExecuted=true"'));
  await page.screenshot({ path: path.join(run, 'sized-document.png') });
  pass('caption input saves immediately and both no-edit and edited source-mode round trips retain image dimensions and inert HTML');

  await action('export-html');
  const html = await fs.readFile(htmlPath, 'utf8'); assert.ok(html.includes(`width="${width}"`));
  const windowPromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => { const window = new BrowserWindow({ show: false, webPreferences: { partition: 'image-sizing-export', nodeIntegration: false, contextIsolation: true, sandbox: true } }); await window.loadFile(file); }, htmlPath);
  const exported = await windowPromise; await exported.waitForURL(pathToFileURL(htmlPath).href); await exported.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth));
  const exportedImages = exported.locator('article img'); assert.equal(await exportedImages.count(), 3);
  assert.ok(Math.abs((await exportedImages.first().boundingBox()).width - width) < 1);
  assert.equal(await exportedImages.first().getAttribute('alt'), '说明 & words'); assert.equal(await exportedImages.first().getAttribute('title'), 'Updated title & "safe"');
  assert.ok(Math.abs((await exportedImages.nth(2).boundingBox()).height - 90) < 1);
  assert.ok((await exportedImages.first().getAttribute('src')).startsWith('data:image/png;base64,'));
  assert.equal(await exported.evaluate(() => window.__imageExecuted), undefined);
  await exported.emulateMedia({ media: 'print' }); assert.ok(Math.abs((await exportedImages.first().boundingBox()).width - width) < 1);
  const plain = await exported.evaluate(() => { document.querySelectorAll('style').forEach(node => node.remove()); document.querySelectorAll('[style]').forEach(node => node.removeAttribute('style')); return document.documentElement.outerHTML; });
  assert.equal(await exportedImages.first().getAttribute('width'), String(width)); assert.ok(Math.abs((await exportedImages.first().boundingBox()).width - width) < 1);
  await fs.writeFile(path.join(run, 'plain-image-sizing.html'), plain); await exported.close();
  await page.emulateMedia({ media: 'print' }); await sized(width); assert.ok(Math.abs((await images().nth(2).boundingBox()).height - 90) < 1); await page.emulateMedia({ media: null });
  await action('export-pdf'); assert.equal((await fs.readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-');
  pass('HTML, print and style-free converter input retain real image widths, embedded pixels and descriptions without executing raw HTML');

  await exit(); await launch(); await sized(width); assert.equal(await images().first().getAttribute('title'), 'Updated title & "safe"');
  assert.equal(await save(), saved);
  pass('reopening preserves the actual resized width and saving without further edits preserves all file bytes');
  assert.deepEqual(errors, []); pass('no renderer exceptions');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally { await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await exit(); console.log(`Evidence: ${run}`); }

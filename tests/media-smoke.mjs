import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin', mod = mac ? 'Meta' : 'Control', endKey = mac ? 'Meta+ArrowDown' : 'Control+End';
const run = path.join(root, 'test-results', `media-${Date.now()}`); await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '图片文稿.md'), newPath = path.join(run, '新文稿.md'), otherPath = path.join(run, '其他文稿.md');
const redPath = path.join(run, '红色 [alt].png'), bluePath = path.join(run, '蓝色.png');
await sharp({ create: { width: 100, height: 60, channels: 3, background: '#c75146' } }).png().toFile(redPath);
await sharp({ create: { width: 100, height: 60, channels: 3, background: '#386cb0' } }).png().toFile(bluePath);
const original = '\uFEFF---\r\ntitle: 元数据保留\r\n---\r\n\r\n# 文稿\r\n\r\n图片从这里开始。\r\n';
await fs.writeFile(documentPath, original); await fs.writeFile(otherPath, '# 不应被切换\n');
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_OPEN_PATH: otherPath, MOYE_TEST_SAVE_PATH: newPath, MOYE_TEST_IMAGE_PATHS: JSON.stringify([redPath, bluePath]), MOYE_TEST_IMAGE_DELAY: '250', MOYE_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
let app, page; const results = [], errors = [];
const record = name => { results.push(name); console.log(`PASS ${name}`); };
async function launch(launchEnv = env, args = ['--open', documentPath]) {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? args : [root, ...args], env: launchEnv, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => { errors.push(error.stack || error.message); console.error(error.stack || error.message); });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
async function command(name) { await page.locator('#format-menu-button').click(); await page.locator(`[data-edit-command="${name}"]`).click(); }
async function sourceText() { await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content').innerText(); }
async function sourceFill(text) { await page.locator('[data-mode="source"]').click(); const source = page.locator('#source-editor .cm-content'); await source.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(text); }
async function saveText() { await action('save'); return fs.readFile(await page.locator('#document-name').getAttribute('title'), 'utf8'); }
async function clipboardImage() { await app.evaluate(({ clipboard, ClipboardItem, nativeImage }, file) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([nativeImage.createFromPath(file).toPNG()], { type: 'image/png' }) })]), redPath); }
async function pasted() { await clipboardImage(); await page.keyboard.press(`${mod}+v`); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已添加')); await idle(); }
async function dropImages() {
  const inputs = await Promise.all([redPath, bluePath].map(async file => ({ name: path.basename(file), bytes: [...await fs.readFile(file)] })));
  const sourceLine = page.locator('#source-editor .cm-line').filter({ hasText: '.assets/' }).first();
  const insideSourceUrl = await page.locator('#source-editor').isVisible();
  if (insideSourceUrl) await sourceLine.scrollIntoViewIfNeeded();
  const coordinates = insideSourceUrl ? await sourceLine.evaluate(line => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent.indexOf('.assets/');
      if (offset < 0) continue;
      const range = document.createRange(); range.setStart(node, offset + 2); range.setEnd(node, offset + 3);
      const bounds = range.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    }
    throw new Error('No image URL under the source drop target');
  }) : null;
  await page.locator('#document-scroll').evaluate((target, { inputs, coordinates }) => {
    const transfer = new DataTransfer(); for (const input of inputs) transfer.items.add(new File([new Uint8Array(input.bytes)], input.name, { type: 'image/png' }));
    const bounds = target.getBoundingClientRect(); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: coordinates?.x ?? bounds.left + bounds.width / 2, clientY: coordinates?.y ?? bounds.top + 70 }));
  }, { inputs, coordinates }); await idle();
}
async function readyImages(count) { await page.waitForFunction(count => { const images = [...document.querySelectorAll('.ProseMirror img')]; return images.length === count && images.every(image => image.naturalWidth === 100 && image.naturalHeight === 60); }, count); }
try {
  await launch(); const rich = page.locator('.ProseMirror');
  await rich.locator('p').last().click(); await page.keyboard.press(endKey);
  await action('image'); await readyImages(2);
  let text = await saveText(); assert.ok(text.startsWith('\uFEFF---\r\ntitle: 元数据保留\r\n---\r\n'));
  assert.ok(text.includes('图片从这里开始。'));
  assert.ok(text.includes('红色')); assert.ok(text.includes('alt')); assert.ok(text.includes('.assets/'));
  assert.equal(await rich.locator('img').first().getAttribute('alt'), '红色 [alt]');
  assert.equal((await fs.readdir(path.join(run, '图片文稿.assets'))).length, 2);
  await page.screenshot({ path: path.join(run, 'native-images.png') });
  record('native multi-image selection writes relative attachments, preserves metadata/alt and displays image pixels');

  await rich.locator(':scope > p').last().click(); await page.keyboard.press(endKey); await pasted(); await readyImages(3);
  await dropImages(); await readyImages(5);
  text = await saveText(); assert.equal((text.match(/!\[/g) || []).length, 5);
  await sourceText(); await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(endKey); await pasted();
  text = await saveText(); assert.equal((text.match(/!\[/g) || []).length, 6);
  const existingImages = text.split(/\r?\n/).filter(line => line.startsWith('!['));
  await dropImages(); text = await saveText(); assert.equal((text.match(/!\[/g) || []).length, 8);
  for (const originalLine of existingImages) assert.ok(text.split(/\r?\n/).includes(originalLine), 'Dropping inside an image URL preserves the entire existing line');
  await page.locator('[data-mode="visual"]').click(); await readyImages(8);
  record('real clipboard image paste and multi-file drop work in both visual and source editors');

  await page.locator('[data-action="image"]').evaluate(button => button.click());
  await page.waitForFunction(() => document.body.classList.contains('is-busy'));
  await page.locator('[data-action="open"]').evaluate(button => button.click());
  await page.locator('[data-mode="source"]').evaluate(button => button.click());
  await idle(); assert.equal(await page.locator('#document-name').textContent(), path.basename(documentPath));
  assert.equal(await page.locator('[data-mode="visual"]').getAttribute('aria-pressed'), 'true');
  await readyImages(10); await saveText();
  assert.equal(await fs.readFile(otherPath, 'utf8'), '# 不应被切换\n');
  record('delayed image storage locks document/mode changes and inserts only into the originating document');

  await action('new'); await rich.click(); await page.keyboard.insertText('未保存的图文稿'); await action('image');
  assert.equal(await page.locator('#document-name').textContent(), path.basename(newPath)); await readyImages(2); await saveText();
  assert.equal((await fs.readdir(path.join(run, '新文稿.assets'))).length, 2);
  record('an untitled document follows normal Save As before any image attachment is written');

  await sourceFill('# Root\n\n## Child\n\n### Deep\n\n#### Four\n\n##### Five\n\n###### Six\n\n' + 'Paragraph text.\n\n'.repeat(30) + '# Second root\n\nTail text.\n');
  await page.locator('[data-mode="visual"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-outline-index]').length === 7);
  await page.locator('[data-outline-toggle]').first().click(); assert.equal(await page.locator('[data-outline-index="5"]').isVisible(), false);
  assert.equal(await page.locator('[data-outline-index="6"]').isVisible(), true);
  await page.locator('[data-outline-control="expand"]').click();
  await page.locator('[data-outline-index="5"]').click();
  await page.waitForFunction(() => document.querySelector('[data-outline-index="5"]').getAttribute('aria-current') === 'location');
  await rich.locator('h1').last().evaluate(node => node.scrollIntoView());
  await page.waitForFunction(() => document.querySelector('[data-outline-index="6"]').getAttribute('aria-current') === 'location');
  await sourceText(); await page.locator('[data-outline-index="5"]').click();
  await page.waitForFunction(() => getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent?.includes('###### Six'));
  record('H1–H6 outline folds hierarchically, jumps in both modes and follows the visible section');

  await sourceFill('Format me\n\nPlain text\n'); await page.locator('[data-mode="visual"]').click();
  const first = rich.locator('p').first(); await first.click(); await page.keyboard.press(mac ? 'Meta+ArrowLeft' : 'Home'); await page.keyboard.press(mac ? 'Meta+Shift+ArrowRight' : 'Shift+End');
  // A DOM range can precede Chromium's selectionchange event on macOS. Wait for
  // the model-driven counter as well, rather than assuming one frame is enough.
  await page.waitForFunction(() => {
    const counter = document.querySelector('#selection-count');
    return getSelection()?.toString() === 'Format me' && !counter?.hidden && counter?.title === '9 个字符（含空白）';
  });
  await command('highlight'); assert.equal(await rich.locator('mark').textContent(), 'Format me');
  await command('undo'); assert.equal(await rich.locator('mark').count(), 0); await command('redo'); assert.equal(await rich.locator('mark').count(), 1);
  await command('sub'); assert.equal(await rich.locator('sub').textContent(), 'Format me');
  await command('sup'); assert.equal(await rich.locator('sup').textContent(), 'Format me');
  await command('strike'); assert.equal(await rich.locator('del').textContent(), 'Format me');
  await command('link'); await page.locator('#insert-href').fill('https://example.com/'); await page.locator('#insert-confirm').click();
  assert.equal(await rich.locator('a[href="https://example.com/"]').textContent(), 'Format me');
  await command('footnote'); await page.locator('#insert-text').fill('A footnote explanation'); await page.locator('#insert-confirm').click();
  assert.equal(await rich.locator('sup[data-type="footnote_reference"]').count(), 1); assert.ok((await rich.innerText()).includes('Format me'));
  await rich.locator(':scope > p').filter({ hasText: 'Plain text' }).click({ position: { x: 20, y: 10 } });
  // Chromium may deliver selectionchange after a synthetic selectOption on macOS.
  // The selection counter is driven by the ProseMirror model, so wait for both selections.
  await page.waitForFunction(() => {
    const selection = document.getSelection(), node = selection?.anchorNode;
    const paragraph = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('.ProseMirror > p');
    return selection?.isCollapsed && paragraph?.textContent === 'Plain text' && document.querySelector('#selection-count')?.hidden;
  });
  await page.locator('#heading-format').selectOption('h6'); assert.equal(await rich.locator('h6').textContent(), 'Plain text');
  await command('toc'); assert.equal(await rich.locator('.moye-toc').count(), 1);
  await sourceFill('Task text\n'); await page.locator('[data-mode="visual"]').click(); await rich.locator('p').click(); await command('task');
  assert.equal(await rich.locator('li .label.unchecked').count(), 1); assert.match(await saveText(), /^[*-] \[ \] Task text/m);
  await sourceFill('An important paragraph\n'); await page.locator('[data-mode="visual"]').click(); await rich.locator('p').click(); await command('alert'); assert.equal(await rich.locator('.moye-alert').count(), 1);
  record('compact format menu supports marks, undo/redo, links, footnotes, H6, TOC, tasks and alerts without deleting selected words');

  await sourceFill('Source words'); await page.keyboard.press(`${mod}+a`); await command('highlight'); assert.equal(await sourceText(), '==Source words==');
  await command('undo'); assert.equal(await sourceText(), 'Source words'); await command('redo'); assert.equal(await sourceText(), '==Source words==');
  await sourceFill('Link label'); await page.keyboard.press(`${mod}+a`); await page.keyboard.press(`${mod}+Alt+k`);
  await page.locator('#insert-href').fill('javascript:alert(1)'); await page.locator('#insert-confirm').click(); assert.equal(await page.locator('#insert-dialog').isVisible(), true);
  await page.locator('#insert-href').fill('https://example.com/a(b)'); await page.locator('#insert-confirm').click(); assert.equal(await sourceText(), '[Link label](https://example.com/a%28b%29)');
  await sourceFill('Selected word'); await page.keyboard.press(`${mod}+a`); await command('footnote'); await page.locator('#insert-text').fill('Source footnote'); await page.locator('#insert-confirm').click();
  assert.ok((await sourceText()).startsWith('Selected word[^note-1]')); assert.ok((await sourceText()).includes('[^note-1]: Source footnote'));
  await sourceFill('Task source'); await page.keyboard.press('ArrowLeft'); await command('task'); assert.equal(await sourceText(), '- [ ] Task source');
  await sourceFill('Sixth heading'); await page.keyboard.press('ArrowLeft'); await page.locator('#heading-format').selectOption('h6'); assert.equal(await sourceText(), '###### Sixth heading');
  await page.locator('[data-mode="visual"]').click(); assert.equal(await rich.locator('h6').textContent(), 'Sixth heading');
  record('source formatting preserves selected text, supports undo/redo and Ctrl/Cmd Alt K, rejects executable links, and formats whole lines');

  await sourceFill('Table below\n\n'); await page.locator('[data-mode="visual"]').click(); await rich.locator('p').last().click(); await command('table');
  await page.locator('#insert-rows').fill('3'); await page.locator('#insert-cols').fill('2'); await page.locator('#insert-confirm').click();
  assert.equal(await rich.locator('tr').count(), 3); assert.equal(await rich.locator('tr').first().locator('th').count(), 2);
  assert.ok((await saveText()).includes('Table below'));
  await rich.locator('td').first().click(); await page.keyboard.insertText('Cell text'); await command('table-row'); assert.equal(await rich.locator('tr').count(), 4);
  await command('table-col'); assert.equal(await rich.locator('tr').first().locator('th').count(), 3);
  await command('table-align-center'); assert.ok((await saveText()).includes(':---:') || (await saveText()).match(/:\s*-+:/));
  await command('table-delete-row'); assert.equal(await rich.locator('tr').count(), 3);
  await command('table-delete-col'); assert.equal(await rich.locator('tr').first().locator('th').count(), 2);
  await command('undo'); assert.equal(await rich.locator('tr').first().locator('th').count(), 3);
  await command('redo'); assert.equal(await rich.locator('tr').first().locator('th').count(), 2);
  await rich.locator('th').first().click(); await command('table-row'); assert.equal(await rich.locator('tr').count(), 4);
  await rich.locator('th').first().click(); await command('table-delete-row'); assert.ok(await rich.locator('tr').first().locator('th').count());
  record('table insertion and discoverable row/column/alignment controls edit the actual Markdown table');

  await sourceFill('```javascript\nconst answer = 42;\nconsole.log(answer);\n```\n'); await page.locator('[data-mode="visual"]').click();
  await page.locator('.milkdown-code-block .copy-button').click();
  let copied = ''; for (let attempt = 0; attempt < 30 && !copied; attempt++) { copied = (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'); if (!copied) await page.waitForTimeout(50); }
  assert.equal(copied, 'const answer = 42;\nconsole.log(answer);');
  const numbers = page.locator('.milkdown-code-block .cm-lineNumbers'); assert.equal(await numbers.isVisible(), true);
  await command('code-lines'); assert.equal(await numbers.isVisible(), false); await command('code-lines'); assert.equal(await numbers.isVisible(), true);
  text = await saveText(); assert.ok(text.includes('const answer = 42;'));
  record('existing code copy writes the real clipboard and code line numbers can be toggled');

  await exit(); const cancelEnv = { ...env, MOYE_USER_DATA: path.join(run, 'cancel-profile'), MOYE_TEST_SAVE_PATH: '' };
  await launch(cancelEnv, []); await action('new'); await page.locator('.ProseMirror').click(); await page.keyboard.insertText('取消保存仍保留文字');
  await action('image'); assert.equal(await page.locator('#document-name').textContent(), '未命名.md'); assert.equal(await page.locator('.ProseMirror img').count(), 0);
  assert.ok((await page.locator('.ProseMirror').innerText()).includes('取消保存仍保留文字'));
  await assert.rejects(fs.stat(path.join(run, '未命名.assets')), { code: 'ENOENT' });
  const beforeCancelledPaste = await sourceText(); await page.locator('#source-editor .cm-content').click(); await clipboardImage(); await page.keyboard.press(`${mod}+v`); await idle();
  assert.equal(await page.locator('#document-name').textContent(), '未命名.md'); assert.equal(await sourceText(), beforeCancelledPaste);
  assert.equal(await page.evaluate(() => navigator.permissions.query({ name: 'clipboard-read' }).then(result => result.state)), 'denied');
  record('canceling Save As preserves untitled text and writes no image or attachment directory');
  assert.deepEqual(errors, []); record('no renderer exceptions');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); await fs.writeFile(path.join(run, 'last-dom.json'), JSON.stringify(await page.evaluate(() => ({ body: document.body.className, lineNumbers: [...document.querySelectorAll('.milkdown-code-block .cm-lineNumbers')].map(node => ({ html: node.outerHTML, display: getComputedStyle(node).display })) })), null, 2)); }
  throw error;
} finally { await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await exit(); console.log(`Evidence: ${run}`); }

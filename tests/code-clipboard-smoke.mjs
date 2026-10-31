import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin', mod = mac ? 'Meta' : 'Control', lineEnd = mac ? 'Meta+ArrowRight' : 'End';
const run = path.join(root, 'test-results', `code-clipboard-${Date.now()}`); await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '代码文稿.md'), htmlPath = path.join(run, 'code.html');
const original = '\uFEFF---\r\ntitle: 保留 YAML\r\n---\r\n\r\n# Code\r\n\r\n```\r\n\tfirst code line\r\n```\r\n\r\n' + 'Paragraph for scrolling.\r\n\r\n'.repeat(65) + '```javascript\r\nconst longLine = "' + '中文 '.repeat(80) + '";\r\n```\r\n';
await fs.writeFile(documentPath, original);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_OPEN_PATH: documentPath, MOYE_TEST_EXPORT_HTML_PATH: htmlPath, MOYE_TEST_DISCARD: 'discard', MOYE_TEST_CLIPBOARD_DELAY: '500' }; delete env.ELECTRON_RUN_AS_NODE;
let app, page; const results = [], errors = [];
const record = name => { results.push(name); console.log(`PASS ${name}`); };
async function launch() {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', documentPath] : [root, '--open', documentPath], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.stack || error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
async function command(name) { await page.locator('#format-menu-button').click(); await page.locator(`[data-edit-command="${name}"]`).click(); }
async function sourceText() { await page.locator('[data-mode="source"]').click(); return page.locator('#source-editor .cm-content').innerText(); }
async function sourceFill(text) { await page.locator('[data-mode="source"]').click(); const source = page.locator('#source-editor .cm-content'); await source.click(); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(text); }
async function visual(text) { await sourceFill(text); await page.locator('[data-mode="visual"]').click(); }
async function saveText() { await action('save'); return fs.readFile(documentPath, 'utf8'); }
async function readClipboard() { return (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'); }
async function options(values = {}) {
  await command('code-settings');
  for (const [id, value] of Object.entries(values)) {
    const control = page.locator(`#code-${id}`);
    if (typeof value === 'boolean') await control.setChecked(value);
    else if (['language-mode', 'indent-kind'].includes(id)) await control.selectOption(String(value));
    else await control.fill(String(value));
  }
  await page.locator('#code-options-dialog button[value="apply"]').click();
  await page.waitForFunction(() => !document.querySelector('#code-options-dialog').open);
}
async function codeText(index = 0) {
  await app.evaluate(({ clipboard }) => clipboard.clear()); await page.locator('.milkdown-code-block .copy-button').nth(index).click();
  for (let attempt = 0; attempt < 30; attempt++) { const text = await readClipboard(); if (text) return text; await page.waitForTimeout(50); }
  throw new Error('Code copy did not write the clipboard.');
}
async function codeEnd() {
  const code = page.locator('.milkdown-code-block .cm-content').first(); await code.click();
  await page.waitForFunction(() => !!document.querySelector('.milkdown-code-block .cm-line span[class]'));
  await page.keyboard.press(mac ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.press(lineEnd);
}
async function selectDocument() {
  await page.locator('.ProseMirror').click();
  await page.waitForFunction(() => document.hasFocus() && document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.press(`${mod}+a`);
  // Clipboard commands read the model selection, which follows the browser's
  // selectionchange event. Wait for it, not only for dispatch of the shortcut.
  await page.waitForFunction(() => !getSelection()?.isCollapsed && !document.querySelector('#selection-count').hidden);
}
async function pasted(commandName, keys) {
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  if (keys) await page.keyboard.press(keys); else await command(commandName);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已粘贴'));
}
// A trusted copy event writes the same custom clipboard type used by VS Code.
// Subsequent paste uses the real operating-system clipboard, not a synthetic paste event.
async function richClipboard(text, withVSCode = true) {
  await page.evaluate(async ({ text, withVSCode }) => {
    // Let a preceding mode switch finish its scheduled editor focus first.
    await new Promise(resolve => requestAnimationFrame(resolve));
    const input = document.createElement('textarea'); input.id = 'clipboard-fixture'; input.value = 'copy fixture'; document.body.append(input); input.focus(); input.select();
    input.addEventListener('copy', event => {
      event.clipboardData.setData('text/plain', text);
      event.clipboardData.setData('text/html', '<h1>HTML branch must not win</h1>');
      if (withVSCode) event.clipboardData.setData('vscode-editor-data', JSON.stringify({ version: 1, mode: 'javascript', isFromEmptySelection: false }));
      event.preventDefault();
      input.dataset.copied = 'true';
    }, { once: true });
  }, { text, withVSCode });
  await page.keyboard.press(`${mod}+c`);
  await page.waitForFunction(() => document.querySelector('#clipboard-fixture')?.dataset.copied === 'true');
  // Native copy reaches the OS clipboard asynchronously, especially on Intel macOS.
  let copied = await readClipboard();
  for (let attempt = 0; copied !== text && attempt < 100; attempt++) { await page.waitForTimeout(50); copied = await readClipboard(); }
  assert.equal(copied, text);
  await page.evaluate(() => document.querySelector('#clipboard-fixture').remove());
}
try {
  await launch();
  assert.equal(await saveText(), original);
  await options({ wrap: true, 'indent-size': 4, 'tab-size': 6, 'auto-indent': false, 'language-mode': 'default', 'default-language': 'python' });
  await options({ 'indent-size': 3.5, 'indent-kind': 'tabs' });
  await page.waitForFunction(async () => (await window.moye.boot()).settings.codeIndentSize === 4);
  await options({ 'indent-kind': 'spaces' });
  assert.equal(await saveText(), original);
  assert.equal(await page.locator('.milkdown-code-block .language-button').first().innerText(), 'Text');
  const firstCode = page.locator('.milkdown-code-block').first();
  assert.ok(['pre-wrap', 'break-spaces'].includes(await firstCode.locator('.cm-content').evaluate(node => getComputedStyle(node).whiteSpace)));
  assert.equal(await firstCode.locator('.cm-content').evaluate(node => getComputedStyle(node).tabSize), '6');
  const lastCode = page.locator('.milkdown-code-block').last(); await lastCode.scrollIntoViewIfNeeded();
  await lastCode.locator('.cm-content').waitFor();
  assert.ok(['pre-wrap', 'break-spaces'].includes(await lastCode.locator('.cm-content').evaluate(node => getComputedStyle(node).whiteSpace)));
  assert.equal(await lastCode.locator('.cm-content').evaluate(node => getComputedStyle(node).tabSize), '6');
  await page.screenshot({ path: path.join(run, 'wrapped-code.png') });
  record('settings update mounted and newly visible code blocks without rewriting BOM, CRLF, YAML or existing untagged fences');

  async function codeContrast() {
    return page.locator('.milkdown-code-block').last().evaluate(block => {
      const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]; };
      return [...block.querySelectorAll('[class*="moye-code-"]')].map(span => {
        const lineBackground = getComputedStyle(span.closest('.cm-line')).backgroundColor;
        const background = lineBackground === 'rgba(0, 0, 0, 0)' ? getComputedStyle(block.querySelector('.cm-editor')).backgroundColor : lineBackground;
        const light = luminance(getComputedStyle(span).color), dark = luminance(background); return (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05);
      });
    });
  }
  for (const theme of ['paper', 'linen', 'night']) {
    await action('style'); await page.locator(`button[data-theme="${theme}"]`).click(); await action('style');
    await lastCode.locator('.moye-code-string').waitFor();
    const contrasts = await codeContrast(); assert.ok(contrasts.length >= 2 && contrasts.every(value => value >= 4.5), `${theme}: ${contrasts}`);
    if (theme === 'night') await page.screenshot({ path: path.join(run, 'night-code.png') });
  }
  await page.emulateMedia({ media: 'print' }); const printContrast = await codeContrast(); assert.ok(printContrast.every(value => value >= 4.5), `print: ${printContrast}`); await page.emulateMedia({ media: 'screen' });
  await action('style'); await page.locator('button[data-theme="paper"]').click(); await action('style');
  record('syntax colors have readable contrast on paper, linen, night and matching print pages');

  await options({ wrap: false, 'indent-size': 4, 'tab-size': 4, 'auto-indent': true, 'language-mode': 'plain' });
  await visual('```javascript\nif (ready) {\n```\n'); await codeEnd(); await page.keyboard.press('Enter'); await page.keyboard.insertText('work();');
  assert.equal(await codeText(), 'if (ready) {\n    work();');
  await codeEnd(); await page.keyboard.press('Tab'); assert.equal(await codeText(), 'if (ready) {\n        work();');
  await options({ 'indent-kind': 'tabs' });
  await visual('```javascript\nif (ready) {\n```\n'); await codeEnd(); await page.keyboard.press('Enter'); await page.keyboard.insertText('work();');
  assert.equal(await codeText(), 'if (ready) {\n\twork();');
  await options({ 'auto-indent': false }); await codeEnd(); await page.keyboard.press('Enter'); await page.keyboard.insertText('noIndent');
  assert.equal(await codeText(), 'if (ready) {\n\twork();\nnoIndent');
  record('real Tab and Enter honor Spaces width, Tabs and the automatic Enter indentation switch');

  await options({ 'language-mode': 'default', 'default-language': 'python' });
  await visual('New code here\n'); await page.locator('.ProseMirror p').click(); await page.locator('[data-format="code"]').click();
  await page.waitForFunction(() => document.querySelector('.milkdown-code-block .language-button')?.textContent.includes('python'));
  await page.locator('.milkdown-code-block .language-button').click(); await page.locator('.milkdown-code-block .search-input').fill('rust');
  await page.locator('.milkdown-code-block [data-language="Rust"]').click();
  await page.waitForFunction(async () => (await window.moye.boot()).settings.codeLastLanguage.toLowerCase() === 'rust');
  await options({ 'language-mode': 'last' });
  await visual('Another code block\n'); await page.locator('.ProseMirror p').click(); await page.locator('[data-format="code"]').click();
  await page.waitForFunction(() => document.querySelector('.milkdown-code-block .language-button')?.textContent.includes('Rust'));
  await sourceFill('Source code'); await page.keyboard.press(`${mod}+a`); await page.locator('[data-format="code"]').click(); assert.match(await sourceText(), /```Rust\nSource code\n```/);
  record('default and last-used language apply to newly inserted blocks, with an actual local language picker and source insertion');

  await visual('Anchor\n'); await richClipboard('## Plain **bold**'); await page.locator('.ProseMirror p').click(); await page.keyboard.press(`${mod}+a`);
  await page.evaluate(() => { document.addEventListener('paste', event => { window.__clipboardTypes = [...event.clipboardData.types]; window.__clipboardVSCode = event.clipboardData.getData('vscode-editor-data'); }, { once: true, capture: true }); });
  await page.keyboard.press(`${mod}+v`);
  await page.locator('.milkdown-code-block .cm-content').waitFor();
  const observed = await page.evaluate(() => ({ types: window.__clipboardTypes, vscode: window.__clipboardVSCode }));
  assert.ok(observed.types.includes('text/html') && observed.types.includes('vscode-editor-data')); assert.equal(JSON.parse(observed.vscode).mode, 'javascript');
  assert.equal(await page.locator('.milkdown-code-block .cm-content').innerText(), '## Plain **bold**');
  // Copying code above is deliberately avoided here, so all metadata remains on the OS clipboard.
  await visual('Anchor\n'); await selectDocument(); await pasted('paste-text', `${mod}+Shift+v`);
  assert.equal(await page.locator('.ProseMirror h2,.ProseMirror strong,.milkdown-code-block').count(), 0);
  assert.equal((await page.locator('.ProseMirror').innerText()).trim(), '## Plain **bold**');
  await command('undo'); assert.equal((await page.locator('.ProseMirror').innerText()).trim(), 'Anchor'); await command('redo');
  await visual('Anchor\n'); await selectDocument(); await pasted('paste-markdown', `${mod}+Alt+v`);
  assert.equal(await page.locator('.ProseMirror h2').innerText(), 'Plain bold'); assert.equal(await page.locator('.ProseMirror h2 strong').innerText(), 'bold');
  assert.equal(await page.locator('.milkdown-code-block').count(), 0); assert.equal(await page.locator('.ProseMirror h1').count(), 0);
  record('real HTML + VS Code clipboard takes its normal code path, while explicit paste shortcuts produce literal text or parsed Markdown with undo');

  await visual('Anchor\n'); await richClipboard('```\nuntagged\n```', false); await selectDocument(); await pasted('paste-markdown');
  await page.waitForFunction(() => document.querySelector('.milkdown-code-block .language-button')?.textContent.includes('Text'));
  assert.equal((await sourceText()).trim(), '```\nuntagged\n```');
  await visual('Anchor\n'); await app.evaluate(({ clipboard }) => clipboard.writeText('```\nnormal paste\n```')); await selectDocument(); await page.keyboard.press(`${mod}+v`);
  await page.waitForFunction(() => document.querySelector('.milkdown-code-block .language-button')?.textContent.includes('Text'));
  await command('undo'); await command('redo');
  await page.waitForFunction(() => document.querySelector('.milkdown-code-block .language-button')?.textContent.includes('Text'));
  await visual('Alpha **bold** omega\n'); await selectDocument(); await command('copy-text');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制为纯文本'));
  assert.equal((await readClipboard()).trim(), 'Alpha bold omega');
  await selectDocument(); await page.keyboard.press(`${mod}+Alt+c`);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制为 Markdown'));
  assert.equal((await readClipboard()).trim(), 'Alpha **bold** omega');
  await page.keyboard.press(`${mod}+Shift+c`); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制为纯文本'));
  assert.equal((await readClipboard()).trim(), 'Alpha bold omega');
  record('explicit/ordinary paste and redo preserve untagged code; explicit copy writes distinct plain text and Markdown');

  await sourceFill('Keep this'); await page.keyboard.press(`${mod}+a`); await richClipboard('## Source **literal**');
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+a`); await pasted('paste-text');
  assert.equal(await sourceText(), '## Source **literal**'); await command('undo'); assert.equal(await sourceText(), 'Keep this');
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+a`); await pasted('paste-markdown');
  assert.equal(await sourceText(), '## Source **literal**');
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+a`); await command('copy-markdown');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制为 Markdown')); assert.equal(await readClipboard(), '## Source **literal**');
  record('both explicit paste modes insert exact Markdown source without HTML conversion, and source undo/copy use the selected text');

  await sourceFill('Keep'); await page.keyboard.press('ArrowRight'); await richClipboard('SHOULD NOT PASTE');
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(mac ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.press(`${mod}+Alt+v`); await page.keyboard.insertText('NEW INPUT');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('文稿已改变'));
  assert.equal(await sourceText(), 'KeepNEW INPUT');
  assert.equal(await page.evaluate(() => navigator.permissions.query({ name: 'clipboard-read' }).then(value => value.state)), 'denied');
  record('delayed clipboard reads never overwrite fresh input, and browser clipboard-read permission remains denied');

  await page.keyboard.press(`${mod}+f`); await page.locator('#find-query').fill('old query'); await page.keyboard.press(`${mod}+a`);
  await app.evaluate(({ clipboard }) => clipboard.writeText('NEW INPUT')); await page.keyboard.press(`${mod}+Shift+v`);
  await page.waitForFunction(() => document.querySelector('#find-query').value === 'NEW INPUT');
  await page.keyboard.press(`${mod}+a`); await page.keyboard.press(`${mod}+Shift+c`);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制文本')); assert.equal(await readClipboard(), 'NEW INPUT');
  await page.locator('[data-action="find-close"]').click(); assert.equal(await sourceText(), 'KeepNEW INPUT');
  record('clipboard shortcuts honor focused search fields without modifying the document selection');

  await action('new'); await page.locator('[data-mode="source"]').click();
  const firstEmptyId = await page.locator('[role="tab"][data-document-id][aria-selected="true"]').getAttribute('data-document-id');
  await app.evaluate(({ clipboard }) => clipboard.writeText('STALE EMPTY DOCUMENT'));
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+Alt+v`);
  await action('new'); await page.locator('[data-mode="source"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('文稿已改变'));
  assert.equal((await sourceText()).trim(), '');
  const secondEmptyId = await page.locator('[role="tab"][data-document-id][aria-selected="true"]').getAttribute('data-document-id');
  assert.ok(firstEmptyId && secondEmptyId); assert.notEqual(firstEmptyId, secondEmptyId);
  assert.match(await page.locator('#document-name').textContent(), /^未命名(?: \d+)?\.md$/);
  await page.locator(`[role="tab"][data-document-id="${firstEmptyId}"]`).click();
  assert.equal((await sourceText()).trim(), '');
  await page.locator(`[role="tab"][data-document-id="${secondEmptyId}"]`).click();
  assert.equal((await sourceText()).trim(), '');
  await action('open');
  record('document generations reject a delayed paste after switching between two empty untitled documents');

  await options({ wrap: false, 'tab-size': 6, 'language-mode': 'last' });
  await visual('```javascript\n\tconst text = "' + 'veryLongIdentifier'.repeat(40) + '";\n```\n'); await action('export-html');
  for (let attempt = 0; attempt < 100 && !(await fs.stat(htmlPath).catch(() => null))?.size; attempt++) await page.waitForTimeout(50);
  const exportWindow = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, file) => { const window = new BrowserWindow({ show: false, webPreferences: { partition: 'moye-test-code-export', nodeIntegration: false, contextIsolation: true, sandbox: true } }); await window.loadFile(file); }, htmlPath);
  const exported = await exportWindow;
  assert.equal(await exported.locator('pre code').evaluate(node => getComputedStyle(node).whiteSpace), 'pre');
  assert.equal(await exported.locator('pre code').evaluate(node => getComputedStyle(node).tabSize), '6');
  await exported.emulateMedia({ media: 'print' });
  assert.equal(await exported.locator('pre code').evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.milkdown-code-block .cm-content').evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
  await exported.close(); await page.emulateMedia({ media: 'screen' });
  record('standalone HTML keeps the screen code wrapping preference and tab width while editor/HTML print always wrap');

  await saveText(); await exit(); await launch();
  await command('code-settings');
  assert.equal(await page.locator('#code-wrap').isChecked(), false); assert.equal(await page.locator('#code-tab-size').inputValue(), '6');
  assert.equal(await page.locator('#code-indent-kind').inputValue(), 'tabs'); assert.equal(await page.locator('#code-language-mode').inputValue(), 'last');
  await page.screenshot({ path: path.join(run, 'code-options.png') });
  record('code settings persist across a real application restart');
  assert.deepEqual(errors, []); record('no renderer exceptions');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally { await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await exit(); console.log(`Evidence: ${run}`); }

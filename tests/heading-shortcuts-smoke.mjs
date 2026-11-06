import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.mkdtemp(path.join(root, 'test-results', 'heading-shortcuts-'));
const file = path.join(run, 'headings.md'), profile = path.join(run, 'profile');
const original = '\uFEFFAlpha **bold**.\r\n\r\nBravo.\r\n\r\nCharlie.\r\n';
await fs.mkdir(profile); await fs.writeFile(file, original);
await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { autoSave: false, autoSaveOnBlur: false, autoSnapshot: false } }));
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control', start = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
const results = [], errors = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); }
async function edit(command) { await page.locator(`[data-edit-command="${command}"]`).evaluate(node => node.click()); }
async function sourceText() { return page.locator('#source-editor .cm-line').evaluateAll(nodes => nodes.map(node => node.textContent).join('\n')); }
async function waitText(expected) { await page.waitForFunction(value => [...document.querySelectorAll('#source-editor .cm-line')].map(node => node.textContent).join('\n') === value, expected); }
async function selectFirstTwoLines() { await page.locator('#source-editor .cm-content').focus(); await page.keyboard.press(start); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown'); }
async function accelerator(command) { return app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(`command-${id}`).accelerator, command); }
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#shell[data-ready="true"]');
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); win.webContents.setZoomFactor(1.25); });
  const first = page.locator('.ProseMirror > :is(p,h1,h2,h3,h4,h5,h6)').first();
  for (let level = 1; level <= 6; level++) {
    assert.equal(await accelerator(`format-h${level}`), `${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+${level}`);
    await first.click(); await page.keyboard.press(`${mod}+${level}`);
    await page.waitForFunction(tag => document.querySelector('.ProseMirror > :is(p,h1,h2,h3,h4,h5,h6)')?.tagName === tag, `H${level}`);
    await page.keyboard.press(`${mod}+${level}`); assert.equal(await first.evaluate(node => node.tagName), `H${level}`);
    assert.equal(await first.textContent(), 'Alpha bold.'); assert.equal(await first.locator('strong').count(), 1);
    assert.equal(await page.locator('#heading-format').inputValue(), `h${level}`);
  }
  await edit('undo'); await page.waitForSelector('.ProseMirror > h5');
  await edit('redo'); await page.waitForSelector('.ProseMirror > h6');
  await page.keyboard.press(`${mod}+0`); await page.waitForSelector('.ProseMirror > p');
  assert.equal(await first.locator('strong').count(), 1);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1.25);
  const reset = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.role === 'resetzoom')?.accelerator);
  assert.equal(reset, 'CmdOrCtrl+Shift+0');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  pass('visual shortcuts set all six levels and paragraph, preserve inline formatting, support undo/redo and leave zoom to Shift+0');

  await page.locator('[data-mode="source"]').click();
  const source = page.locator('#source-editor .cm-content');
  const body = await sourceText(), suffix = body.slice(body.indexOf('\n'));
  for (let level = 1; level <= 6; level++) {
    await source.focus(); await page.keyboard.press(start); await page.keyboard.press(`${mod}+${level}`);
    const expected = `${'#'.repeat(level)} Alpha **bold**.${suffix}`;
    await waitText(expected); await page.keyboard.press(`${mod}+${level}`); assert.equal(await sourceText(), expected);
  }
  await edit('undo'); await waitText(`##### Alpha **bold**.${suffix}`);
  await edit('redo'); await waitText(`###### Alpha **bold**.${suffix}`);
  await page.keyboard.press(`${mod}+0`); await waitText(body);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  pass('source shortcuts replace heading prefixes without duplication, preserve other lines and disk bytes, and support undo/redo');

  await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText('First line\nSecond line\nThird untouched');
  await selectFirstTwoLines(); await page.keyboard.press(`${mod}+3`); await waitText('### First line\n### Second line\nThird untouched');
  await selectFirstTwoLines(); await page.keyboard.press(`${mod}+0`); await waitText('First line\nSecond line\nThird untouched');
  pass('a source selection formats only the selected lines and can return them to paragraph text');

  const unchanged = await sourceText();
  await action('find'); await page.locator('#find-query').fill('search'); await page.keyboard.press(`${mod}+1`);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-format-h1').click());
  assert.equal(await sourceText(), unchanged); assert.equal(await page.locator('#find-query').inputValue(), 'search'); await action('find-close');
  await action('shortcut-settings'); await page.locator('#shortcuts-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press(`${mod}+2`); await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-format-h2').click());
  assert.equal(await sourceText(), unchanged); assert.equal(await page.locator('#shortcuts-dialog').isVisible(), true);
  await page.locator('[data-shortcut-id="format-h2"][data-shortcut-action="record"]').click(); await page.keyboard.press(`${mod}+j`);
  await page.waitForFunction(() => document.querySelector('#shortcut-feedback')?.textContent === '快捷键已保存。');
  await page.keyboard.press('Escape'); await page.locator('#shortcuts-dialog').waitFor({ state: 'hidden' });
  assert.equal(await accelerator('format-h2'), `${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+J`);
  await source.focus(); await page.keyboard.press(start); await page.keyboard.press(`${mod}+2`); assert.equal(await sourceText(), unchanged);
  await page.keyboard.press(`${mod}+j`); await waitText('## First line\nSecond line\nThird untouched');
  pass('text fields and dialogs cannot format the document; a remapped heading command updates menus and retires its old shortcut');
  assert.deepEqual(errors, []); pass('no renderer exceptions');
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  if (page) await fs.writeFile(path.join(run, 'last-state.html'), await page.locator('.ProseMirror').innerHTML().catch(() => 'unavailable'));
  throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  console.log(`Evidence: ${run}`);
}

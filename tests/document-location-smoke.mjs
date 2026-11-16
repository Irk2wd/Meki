import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(root, 'test-results', 'document-location-')));
const profile = path.join(run, 'profile'), first = path.join(run, "中文 & '文稿'.md"), second = path.join(run, 'other.md'), saved = path.join(run, 'saved.md'), unknown = path.join(run, 'unknown.md');
const original = '\uFEFF# Local file\r\n\r\nUnchanged Markdown.\r\n';
for (const file of [first, second, unknown]) await fs.writeFile(file, original);
const env = { ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: profile, MEKI_TEST_DISCARD: 'discard', MEKI_TEST_OPEN_PATH: second, MEKI_TEST_SAVE_PATH: saved };
delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(node => node.click()); await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function menu(target = page.locator('.document-tab.active')) { await target.click({ button: 'right' }); await page.locator('#document-menu').waitFor({ state: 'visible' }); }
async function choose(action, file) {
  const key = action === 'reveal' ? 'MEKI_TEST_REVEALED_PATH' : 'MEKI_TEST_COPIED_PATH';
  await app.evaluate((_electron, key) => { delete process.env[key]; }, key);
  await page.locator(`#document-menu [data-document-action="${action}"]`).click();
  await page.locator('#document-menu').waitFor({ state: 'hidden' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await app.evaluate((_electron, key) => process.env[key], key) === file) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`File action did not target ${file}`);
}
async function reject(action, file) {
  return page.evaluate(async ({ action, file }) => { try { await window.meki.documentPathAction(action, file); return ''; } catch (error) { return String(error); } }, { action, file });
}
try {
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args: process.env.MEKI_EXECUTABLE ? ['--open', first] : [root, '--open', first], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1200, 850); win.show(); win.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]');
  await menu();
  assert.equal(await page.locator('#document-menu [data-document-action="reveal"]').innerText(), process.platform === 'darwin' ? '在 Finder 中显示' : '在资源管理器中显示');
  await choose('reveal', first);
  await menu(page.locator('#document-name')); await choose('copy-path', first);
  assert.equal(await page.locator('#document-name').textContent(), path.basename(first));
  pass('saved document tabs and the title reveal the exact file or copy its full path, including Unicode and special characters');

  await action('open');
  await page.waitForFunction(() => document.querySelector('#document-name').textContent === 'other.md');
  await page.locator('[data-mode="source"]').click();
  const source = page.locator('#source-editor .cm-content'); await source.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.insertText('\nUnsaved buffer');
  await page.waitForFunction(() => !document.querySelector('#dirty-dot').hidden);
  const activeId = await page.locator('.document-tab.active [role=tab]').getAttribute('data-document-id');
  const text = await source.innerText();
  const firstTab = page.locator('.document-tab').filter({ hasText: path.basename(first) });
  await menu(firstTab); await choose('reveal', first);
  assert.equal(await page.locator('.document-tab.active [role=tab]').getAttribute('data-document-id'), activeId);
  assert.equal(await source.innerText(), text); assert.equal(await page.locator('#dirty-dot').isVisible(), true);
  await menu(); await page.keyboard.press('Escape'); await page.locator('#document-menu').waitFor({ state: 'hidden' });
  pass('right-clicking a background tab targets that file without switching, saving or changing the active dirty editor');

  await firstTab.locator('.close-document-tab').click();
  await page.locator('[data-tab="files"]').click();
  const recent = page.locator('.workspace-tree-row').filter({ hasText: path.basename(first) });
  await recent.click({ button: 'right' }); await page.locator('#workspace-menu').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace-menu [data-ws-menu="reveal"]').innerText(), process.platform === 'darwin' ? '在 Finder 中显示' : '在资源管理器中显示');
  await app.evaluate(() => { delete process.env.MEKI_TEST_REVEALED_PATH; });
  await page.locator('#workspace-menu [data-ws-menu="reveal"]').click();
  await page.waitForFunction(() => document.querySelector('#workspace-menu').hidden);
  for (let attempt = 0; attempt < 100 && await app.evaluate(() => process.env.MEKI_TEST_REVEALED_PATH) !== first; attempt++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await app.evaluate(() => process.env.MEKI_TEST_REVEALED_PATH), first);
  assert.equal(await page.locator('#document-name').textContent(), 'other.md');
  await recent.focus(); await page.keyboard.press('Shift+F10'); await page.locator('#workspace-menu').waitFor({ state: 'visible' }); await page.keyboard.press('Escape');
  pass('recent documents have mouse and keyboard context menus even without an open workspace and do not reopen the file');

  assert.match(await reject('reveal', unknown), /请先打开/); assert.match(await reject('copy-path', unknown), /请先打开/);
  assert.ok(await reject('delete', second)); assert.ok(await reject('reveal', '../outside.md')); assert.ok(await reject('reveal', null));
  await fs.unlink(first);
  assert.match(await reject('reveal', first), /已不存在/);
  await fs.writeFile(first, original);
  pass('the main process rejects unknown paths, invalid actions and missing files without granting new file access');

  await action('new'); await menu();
  assert.equal(await page.locator('#document-menu [data-document-action="reveal"]').isDisabled(), true);
  assert.equal(await page.locator('#document-menu [data-document-action="copy-path"]').isDisabled(), true);
  assert.match(await page.locator('#document-menu').innerText(), /请先保存/);
  await page.keyboard.press('Escape'); await action('save');
  await page.waitForFunction(() => document.querySelector('#document-name').textContent === 'saved.md');
  await menu(); await choose('reveal', saved);
  await page.locator('.document-tab.active [role=tab]').focus(); await page.keyboard.press('Shift+F10');
  await page.locator('#document-menu').waitFor({ state: 'visible' });
  await page.keyboard.press('End');
  assert.equal(await page.locator('#document-menu [data-document-action="copy-path"]').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  pass('untitled documents explain why file actions are unavailable; saving enables them and keyboard navigation restores focus');

  await action('style'); await page.locator('[data-theme="night"]').click(); await action('style');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 600));
  await menu();
  assert.equal(await page.locator('#document-menu').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }), true);
  await page.screenshot({ path: path.join(run, 'context-menu-night.png') });
  await page.keyboard.press('Escape');
  for (const file of [first, second, unknown]) assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(errors, []); pass('menus fit a narrow themed window, preserve document bytes and cause no renderer errors');
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  console.log(`Evidence: ${run}`);
}

import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.mkdtemp(path.join(root, 'test-results', 'about-'));
const documentPath = path.join(run, 'about.md'), original = '\uFEFF# About check\r\n\r\nKeep these bytes.\r\n';
await fs.writeFile(documentPath, original);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = [], pass = name => { results.push(name); console.log(`PASS ${name}`); };
let app, page;
try {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', documentPath] : [root, '--open', documentPath], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, shell }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
    globalThis.aboutOpenedLinks = [];
    shell.openExternal = async url => { globalThis.aboutOpenedLinks.push(url); };
  });
  await page.waitForSelector('#shell[data-ready="true"]');
  const menuCount = await app.evaluate(({ Menu }) => {
    const walk = items => items.flatMap(item => [item, ...(item.submenu ? walk(item.submenu.items) : [])]);
    const items = walk(Menu.getApplicationMenu().items).filter(item => item.label === '关于 Meki');
    items[0].click(); return items.length;
  });
  assert.equal(menuCount, process.platform === 'darwin' ? 2 : 1);
  await page.locator('#about-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#about-title').textContent(), '关于 Meki');
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'Meki');
  assert.match(await page.title(), /Meki/);
  assert.equal(await page.locator('#about-version').textContent(), pkg.version);
  assert.equal(await page.locator('#about-developer').textContent(), 'Irk2wd');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-about').click());
  assert.equal(await page.locator('#about-dialog[open]').count(), 1);
  await page.screenshot({ path: path.join(run, 'about-paper.png') });
  await page.keyboard.press('Escape'); await page.locator('#about-dialog').waitFor({ state: 'hidden' });
  pass('native menus open one accessible About dialog with the running version and developer');

  await page.locator('[data-mode="source"]').click();
  const source = page.locator('#source-editor .cm-content'); await source.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText('\nUnsaved writing stays here.');
  const unsaved = await source.innerText();
  await page.locator('[data-action="about"]').click();
  assert.equal(await page.locator('#about-notices-text').textContent(), '');
  await page.locator('#about-notices summary').click();
  await page.waitForFunction(() => document.querySelector('#about-notices-text').textContent.startsWith('Meki third-party notices'));
  assert.equal(await page.locator('#about-notices-text *').count(), 0);
  await page.locator('[data-about="project"]').click();
  assert.deepEqual(await app.evaluate(() => globalThis.aboutOpenedLinks), ['https://github.com/Irk2wd/Meki']);
  assert.equal(await page.locator('#about-dialog').isVisible(), true);
  await page.locator('[data-about="updates"]').click();
  await page.locator('#update-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#about-dialog').isVisible(), false);
  assert.equal(await page.evaluate(async () => (await window.moye.updateState()).status), 'idle');
  await page.locator('[data-update="close"]').click();
  assert.equal(await source.innerText(), unsaved);
  assert.equal(await fs.readFile(documentPath, 'utf8'), original);
  pass('local notices render as text, project uses the system browser, and updates preserve unsaved edits without checking automatically');

  await page.locator('[data-action="style"]').first().click(); await page.locator('[data-theme="night"]').click();
  await page.locator('[data-action="style"]').first().click();
  await page.locator('[data-action="about"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(500, 600));
  await page.locator('#about-notices summary').click();
  const geometry = await page.locator('#about-dialog').evaluate(dialog => {
    const bounds = dialog.getBoundingClientRect();
    return { fits: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, scrollsX: dialog.scrollWidth > dialog.clientWidth };
  });
  assert.deepEqual(geometry, { fits: true, scrollsX: false });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
  await page.screenshot({ path: path.join(run, 'about-night-narrow.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 850));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-action="about"]').evaluate(element => element === document.activeElement), true);
  assert.deepEqual(errors, []);
  pass('night theme and narrow windows stay readable; Escape restores focus to the entry');

  if (process.platform === 'darwin') {
    await Promise.all([page.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())]);
    const reopened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('command-about').click());
    page = await reopened; await page.waitForSelector('#about-dialog[open]');
    assert.equal(await page.locator('#about-version').textContent(), pkg.version);
    pass('macOS application menu restores an editor and opens About after all windows close');
  }
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(`Evidence: ${run}`);
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  throw error;
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
}

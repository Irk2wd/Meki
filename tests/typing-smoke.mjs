import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(root, 'test-results', `typing-${Date.now()}`), profile = path.join(run, 'profile');
await fs.mkdir(run, { recursive: true });
const file = path.join(run, '原文.md'), original = '\uFEFF# 原文\r\n\r\n"原样" -- $x$\r\n';
await fs.writeFile(file, original);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const start = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home', end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'discard' }; delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = []; let app, page;
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function ready(target) { target.setDefaultTimeout(15000); target.on('pageerror', error => errors.push(error.message)); await target.waitForSelector('#shell[data-ready="true"]'); return target; }
async function focus(target = page) { const win = await app.browserWindow(target); await win.evaluate(win => { win.show(); win.focus(); }); await target.waitForFunction(() => document.hasFocus()); }
async function idle(target = page) { await target.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name, target = page) { await target.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(target); }
async function mode(value, target = page) { await target.locator(`[data-mode="${value}"]`).click(); await target.locator(value === 'visual' ? '.ProseMirror' : '#source-editor .cm-content').waitFor({ state: 'visible' }); await idle(target); }
async function launch() {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await ready(await app.firstWindow()); await focus();
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function fresh(text = '', visual = true, target = page) {
  await focus(target); const before = await target.locator('.document-tab.active [role="tab"]').getAttribute('data-document-id');
  await action('new', target);
  await target.waitForFunction(before => document.querySelector('.document-tab.active [role="tab"]')?.getAttribute('data-document-id') !== before, before);
  await mode('source', target); await target.locator('#source-editor .cm-content').focus();
  if (text) await target.keyboard.insertText(text);
  await target.waitForFunction(text => [...document.querySelectorAll('#source-editor .cm-line')].map(line => line.textContent).join('\n') === text, text);
  if (visual) { await mode('visual', target); await target.locator('.ProseMirror').focus(); await target.keyboard.press(end); }
}
async function prose(expected, target = page) { await target.waitForFunction(expected => document.querySelector('.ProseMirror')?.textContent === expected, expected); }
async function source(expected, target = page) { await target.waitForFunction(expected => [...document.querySelectorAll('#source-editor .cm-line')].map(line => line.textContent).join('\n') === expected, expected); }
async function setting(key, value, target = page) {
  if (!await target.locator('#style-panel').isVisible()) await action('style', target);
  const details = target.locator('.typing-settings'); if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
  const names = { typingAutoPair: 'typing-auto-pair', typingMarkdownPairs: 'typing-markdown-pairs', typingSmartQuotes: 'typing-smart-quotes', typingSmartDashes: 'typing-smart-dashes' };
  if (key === 'typingAutoPair') await target.locator(`#${names[key]}`).selectOption(value); else await target.locator(`#${names[key]}`).setChecked(value);
  await target.waitForFunction(async ({ key, value }) => (await window.moye.boot()).settings[key] === value, { key, value });
  await action('style', target);
}
async function selectAllProse() {
  await page.locator('.ProseMirror').click(); await page.keyboard.press(end); await page.keyboard.press(`Shift+${start}`);
  await page.waitForFunction(() => !getSelection().isCollapsed && !document.querySelector('#selection-count').hidden);
}
async function undo() { await page.keyboard.press(`${mod}+z`); }

try {
  await launch();
  const defaults = (await page.evaluate(() => window.moye.boot())).settings;
  assert.equal(defaults.typingAutoPair, 'default'); assert.equal(defaults.typingSmartQuotes, false); assert.equal(defaults.typingSmartDashes, false); assert.equal(defaults.typingMarkdownPairs, false);
  await setting('typingSmartQuotes', true); await setting('typingSmartQuotes', false); await mode('source'); await mode('visual'); await action('save');
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await fresh(); await page.keyboard.type('('); await prose('(');
  await fresh('', false); await page.keyboard.type('('); await source('()'); await page.keyboard.type(')'); await source('()');
  pass('default settings retain visual/source pairing behavior and no-edit saves preserve BOM/CRLF');

  await setting('typingAutoPair', 'on'); await fresh(); await page.keyboard.type('('); await prose('()');
  await page.keyboard.type('x)'); await prose('(x)'); await page.keyboard.type('!'); await prose('(x)!');
  await fresh(); await page.keyboard.type('['); await prose('[]'); await page.keyboard.press('Backspace'); await prose(''); await undo(); await prose('[]');
  await fresh('word'); await selectAllProse(); await page.keyboard.type('('); await prose('(word)'); await undo(); await prose('word');
  pass('visual pairing wraps selections, skips generated closers, deletes empty pairs and undoes in one step');

  await setting('typingMarkdownPairs', true); await fresh('word'); await selectAllProse(); await page.keyboard.type('*');
  await page.locator('.ProseMirror em').waitFor(); assert.equal(await page.locator('.ProseMirror em').textContent(), 'word');
  await page.keyboard.type('*'); await page.locator('.ProseMirror strong').waitFor(); await undo(); await page.locator('.ProseMirror em').waitFor(); await undo(); assert.equal(await page.locator('.ProseMirror em').count(), 0); await prose('word');
  await fresh('x^2'); await selectAllProse(); await page.keyboard.type('$'); await page.locator('.moye-inline-math[data-value="x^2"]').waitFor();
  await undo(); await prose('x^2');
  pass('Markdown selection symbols create semantic marks and editable formulas with isolated undo');

  await setting('typingSmartQuotes', true); await setting('typingSmartDashes', true);
  await fresh(); await page.keyboard.type('"hello" It\'s word--word'); await prose('“hello” It’s word—word');
  await fresh('word-'); await page.keyboard.type('-'); await prose('word—'); await undo(); await prose('word-');
  await fresh(); await page.keyboard.type('---'); await page.locator('.ProseMirror hr').waitFor();
  pass('smart quotes cooperate with pairing, apostrophes and undo; Markdown thematic breaks remain usable');

  await fresh('`code`'); await page.locator('.ProseMirror code').click(); await page.keyboard.press('ArrowRight'); await page.keyboard.type('"--');
  assert.ok((await page.locator('.ProseMirror code').textContent()).includes('"--'));
  await fresh('$x='); await page.keyboard.type('"--'); await prose('$x="--');
  await fresh('```text\ncode\n```');
  const block = page.locator('.milkdown-code-block .cm-content').first(); await block.waitFor({ state: 'visible' }); await block.focus(); await page.keyboard.press(end); await page.keyboard.type(' "raw" --');
  assert.ok((await block.textContent()).includes('"raw" --'));
  await fresh('$$\nx\n$$');
  const mathBlock = page.locator('.milkdown-code-block').first(); await mathBlock.getByText('编辑源码', { exact: true }).click();
  const mathSource = mathBlock.locator('.cm-content'); await mathSource.focus(); await page.keyboard.press(end); await page.keyboard.type(' "--');
  assert.ok((await mathSource.textContent()).includes('"--'));
  pass('inline code, fenced code, formula source and unfinished inline TeX retain literal punctuation');

  await fresh(); const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中文"(', selectionStart: 4, selectionEnd: 4 });
  await cdp.send('Input.insertText', { text: '中文"(' }); await prose('中文"(');
  await page.waitForTimeout(80); await page.keyboard.type(' "ok"'); await prose('中文"( “ok”'); await cdp.detach();
  pass('Chromium IME composition preserves committed Chinese/punctuation and normal typing resumes afterward');

  await fresh('', false); await page.keyboard.type('('); await source('()'); await page.keyboard.type(')'); await source('()');
  await page.keyboard.type(' "raw" --'); await source('() "raw" --');
  const oldTab = await page.locator('.document-tab.active [role="tab"]').getAttribute('data-document-id');
  await fresh('', false); await setting('typingAutoPair', 'off'); await page.locator('#source-editor .cm-content').focus(); await page.keyboard.type('('); await source('(');
  await page.locator(`.document-tab [role="tab"][data-document-id="${oldTab}"]`).click(); await idle(); await page.locator('#source-editor .cm-content').focus(); await page.keyboard.press(end); await page.keyboard.type('('); await source('() "raw" --(');
  await fresh(); await page.keyboard.type('('); await prose('(');
  pass('source uses one existing pair handler, keeps smart punctuation literal and reapplies disabled pairing to restored tabs');

  await setting('typingAutoPair', 'on'); await fresh('', false); await page.keyboard.type('('); await source('()');
  await setting('typingAutoPair', 'off'); await page.locator('#source-editor .cm-content').focus(); await page.keyboard.press('Backspace'); await source(')');
  await setting('typingAutoPair', 'on'); await fresh(); await page.keyboard.type('('); await prose('()');
  await setting('typingAutoPair', 'off'); await page.locator('.ProseMirror').focus(); await page.keyboard.press('Backspace'); await prose(')');
  pass('disabling pairing immediately stops paired Backspace for previously generated pairs in both editors');

  const created = app.waitForEvent('window'); await action('window-menu'); await page.locator('#window-panel [data-action="new-window"]').click();
  const second = await ready(await created); await focus(second);
  assert.equal(await second.locator('#typing-auto-pair').inputValue(), 'off'); assert.equal(await second.locator('#typing-smart-quotes').isChecked(), true);
  await setting('typingAutoPair', 'on', second); await page.waitForFunction(() => document.querySelector('#typing-auto-pair').value === 'on');
  await fresh('', true, page); await page.keyboard.type('('); await prose('()');
  await setting('typingSmartQuotes', false, page); await second.waitForFunction(() => !document.querySelector('#typing-smart-quotes').checked);
  await focus(second); await fresh('', true, second); await second.keyboard.type('"'); await prose('""', second);
  await setting('typingSmartQuotes', true, second);
  pass('typing controls broadcast between native windows and immediately affect both editors');

  await focus(); const win = await app.browserWindow(page); await win.evaluate(win => win.setSize(860, 650));
  await action('style'); await page.locator('.typing-settings summary').scrollIntoViewIfNeeded();
  if (!await page.locator('.typing-settings').evaluate(node => node.open)) await page.locator('.typing-settings summary').click();
  await page.locator('#typing-smart-dashes').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(run, 'typing-settings.png') }); await action('style');
  await exit(); await launch();
  const restored = (await page.evaluate(() => window.moye.boot())).settings;
  assert.equal(restored.typingAutoPair, 'on'); assert.equal(restored.typingMarkdownPairs, true); assert.equal(restored.typingSmartQuotes, true); assert.equal(restored.typingSmartDashes, true);
  await fresh(); await page.keyboard.type('"persist"'); await prose('“persist”');
  pass('input preferences persist across process restart and the settings remain reachable at a smaller window size');
  assert.deepEqual(errors, []); pass('no renderer exceptions');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally { await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await exit(); console.log(`Evidence: ${run}`); }

import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin', mod = mac ? 'Meta' : 'Control';
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const run = await fs.mkdtemp(path.join(root, 'test-results', 'text-drag-'));
const file = path.join(run, 'selection.md'), profile = path.join(run, 'profile');
const first = 'Alpha bravo charlie delta echo foxtrot.', second = 'Second paragraph destination.';
const original = `\uFEFF${first}\r\n\r\n${second}\r\n`;
await fs.mkdir(profile);
await fs.writeFile(file, original);
await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { autoSave: false, autoSnapshot: false, spellcheck: false } }));
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, failure;
const results = [], errors = [];
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function selectWord(backward = false) {
  await page.locator('.ProseMirror').focus();
  await page.keyboard.press(mac ? 'Meta+ArrowUp' : 'Control+Home');
  for (let i = 0; i < (backward ? 11 : 6); i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press(backward ? 'ArrowLeft' : 'ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => getSelection()?.toString() === 'bravo' && !document.querySelector('#selection-count').hidden);
}
async function point(paragraph, offset) {
  return page.locator('.ProseMirror > p').nth(paragraph).evaluate((node, offset) => {
    const range = document.createRange(); range.setStart(node.firstChild, offset); range.collapse(true);
    const rect = range.getBoundingClientRect(); return { x: rect.left + .1, y: (rect.top + rect.bottom) / 2 };
  }, offset);
}
async function undo() {
  await page.keyboard.press(`${mod}+z`);
  await page.waitForFunction(({ first, second }) => {
    const paragraphs = [...document.querySelectorAll('.ProseMirror > p')].map(node => node.textContent);
    return paragraphs.length === 2 && paragraphs[0] === first && paragraphs[1] === second;
  }, { first, second });
}
async function drag({ copy = false, cancel = false } = {}) {
  const start = await point(0, 8), end = await point(1, 7);
  // Each case is an independent gesture. ProseMirror infers triple clicks from
  // nearby mousedowns within 500 ms even when keyboard selection/undo intervenes.
  await page.waitForTimeout(550);
  await page.evaluate(() => { window.textDragEvents = []; });
  if (copy) await page.keyboard.down(mac ? 'Alt' : 'Control');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  assert.equal(await page.evaluate(() => getSelection().toString()), 'bravo', 'pressing selected text must preserve the range until the gesture is known');
  // Chromium on macOS treats movement within 150 ms as a new selection.
  if (mac) await page.waitForTimeout(200);
  await page.mouse.move(start.x + 12, start.y, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 15 });
  await page.mouse.move(end.x + 1, end.y, { steps: 2 });
  await page.waitForFunction(() => window.textDragEvents.some(event => event.type === 'dragstart'));
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  if (copy) await page.keyboard.up(mac ? 'Alt' : 'Control');
  await page.waitForFunction(() => window.textDragEvents.some(event => event.type === 'dragend'));
  if (cancel) {
    assert.equal(await page.locator('.ProseMirror > p').nth(0).textContent(), first);
    assert.equal(await page.locator('.ProseMirror > p').nth(1).textContent(), second);
    assert.equal(await page.locator('.ProseMirror > p').count(), 2);
  } else {
    await page.waitForFunction(copy => {
      const node = document.querySelector('.ProseMirror');
      return (node.textContent.match(/bravo/g) || []).length === (copy ? 2 : 1)
        && node.firstElementChild.textContent.includes('bravo') === copy
        && window.textDragEvents.some(event => event.type === 'drop');
    }, copy);
    assert.ok((await page.evaluate(() => window.textDragEvents)).some(event => event.type === 'drop' && event.text === 'bravo'));
  }
}
try {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', file] : [root, '--open', file], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]');
  await page.evaluate(() => {
    window.textDragEvents = [];
    for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => window.textDragEvents.push({ type, text: event.dataTransfer?.getData('text/plain') }));
    window.selectionEvents = [];
    for (const type of ['mousedown', 'mouseup', 'keydown', 'selectionchange']) document.addEventListener(type, event => {
      window.selectionEvents.push({ type, key: event.key, detail: event.detail, selected: getSelection()?.toString(), focused: document.activeElement?.className, countHidden: document.querySelector('#selection-count').hidden });
      if (window.selectionEvents.length > 40) window.selectionEvents.shift();
    });
  });
  for (const backward of [false, true]) {
    await selectWord(backward); await drag(); await undo();
    pass(`${backward ? 'backward' : 'forward'} selected text moves through native drag and one undo restores both paragraphs`);
  }
  await selectWord(); await drag({ copy: true }); await undo();
  pass('platform copy modifier duplicates selected text and undo removes only the duplicate');
  await selectWord(); await drag({ cancel: true });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  pass('Escape cancels native text dragging and unsaved interactions leave BOM/CRLF disk bytes unchanged');
  for (const [paragraph, offset, expected] of [[0, 8, 'Alpha brxavo charlie delta echo foxtrot.'], [1, 7, 'Second xparagraph destination.']]) {
    await selectWord();
    const caret = await point(paragraph, offset);
    await page.mouse.click(caret.x, caret.y); await page.keyboard.press('x');
    await page.waitForFunction(({ paragraph, expected }) => document.querySelectorAll('.ProseMirror > p')[paragraph]?.textContent === expected, { paragraph, expected });
    await undo();
    pass(`a plain click ${paragraph === 0 ? 'inside' : 'outside'} the previous selection followed immediately by typing uses the clicked caret`);
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.keyboard.press(`${mod}+a`);
    const caret = await point(0, 8);
    await page.mouse.click(caret.x, caret.y);
    await page.keyboard.press(`${mod}+a`);
    await page.waitForFunction(() => getSelection()?.toString().includes('Second paragraph destination.') && !document.querySelector('#selection-count').hidden);
  }
  pass('clicking an existing full-document selection and immediately selecting all keeps browser and editor selections synchronized');
  const word = await point(0, 8), extension = await point(1, 7);
  // Start a fresh click sequence after the rapid single-click regression.
  await page.waitForTimeout(550);
  await page.mouse.dblclick(word.x, word.y);
  await page.waitForFunction(() => getSelection()?.toString().trim() === 'bravo' && !document.querySelector('#selection-count').hidden);
  await page.keyboard.down('Shift'); await page.mouse.click(extension.x, extension.y); await page.keyboard.up('Shift');
  await page.waitForFunction(() => getSelection()?.toString().includes('charlie delta echo foxtrot.') && getSelection()?.toString().includes('Second'));
  assert.equal(await fs.readFile(file, 'utf8'), original);
  pass('native double-click word selection and Shift-click extension keep their usual behavior without changing the file');
  assert.deepEqual(errors, []);
} catch (error) {
  failure = { message: error.message, selectionEvents: page ? await page.evaluate(() => window.selectionEvents).catch(() => []) : [] };
  if (page) { await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {}); await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, failure }, null, 2));
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  console.log(`Evidence: ${run}`);
}

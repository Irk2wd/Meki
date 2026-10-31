import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin', mod = mac ? 'Meta' : 'Control';
const startKey = mac ? 'Meta+ArrowUp' : 'Control+Home', endKey = mac ? 'Meta+ArrowDown' : 'Control+End';
const run = path.join(root, 'test-results', `writing-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const documentPath = path.join(run, '写作.md'), htmlPath = path.join(run, 'export.html');
const original = '\uFEFF' + [
  '---', 'title: hidden-cat', '---', '', '# Writing test', '',
  'Bold **joined** text and **untouched**.', '',
  'cat Cat scatter cat_ cat2 cat 猫cat cat猫.', '', 'item-12 item-34', '',
  '中文 two words', '', 'Inline $x+1$ formula.', '', '$$', 'x+1', '$$', '',
  '<span>raw-token</span>', '', 'a'.repeat(45) + '!', '',
  ...Array.from({ length: 65 }, (_, i) => `Paragraph ${i + 1}. This paragraph makes a long writing document.\n`),
].join('\r\n');
const selectionFixture = '\uFEFF# 拖选检查\r\n\r\n' + '拖选检查：' + '这一段用于验证跨行选择时文字位置保持稳定。'.repeat(12)
  + '\r\n\r\n' + Array.from({ length: 40 }, (_, i) => `后续段落 ${i + 1}，只选择目标段落。\r\n`).join('\r\n');
await fs.writeFile(documentPath, selectionFixture);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: path.join(run, 'profile'), MOYE_TEST_OPEN_PATH: documentPath, MOYE_TEST_EXPORT_HTML_PATH: htmlPath, MOYE_TEST_DISCARD: 'discard' };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const results = [], errors = [], selections = [];
const record = name => { results.push(name); console.log(`PASS ${name}`); };
async function launch() {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', documentPath] : [root, '--open', documentPath], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]', { timeout: 30000 });
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function idle() { await page.waitForFunction(() => !document.body.classList.contains('is-busy')); }
async function action(name) { await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click()); await idle(); }
async function found(total, index) {
  await page.waitForFunction(({ total, index }) => {
    const text = document.querySelector('#find-count').textContent;
    return index === undefined ? new RegExp(`^\\d+ / ${total}$`).test(text) : text === `${index} / ${total}`;
  }, { total, index });
}
async function search(query, { regex = false, word = false, sensitive = false, total } = {}) {
  await page.locator('#find-regex').setChecked(regex); await page.locator('#find-word').setChecked(word); await page.locator('#find-case').setChecked(sensitive);
  await page.locator('#find-query').fill(query); if (total !== undefined) await found(total);
}
async function replace(value, all = false) {
  if (!(await page.locator('#replace-row').isVisible())) await page.locator('[data-writing-action="toggle-replace"]').click();
  await page.locator('#find-replacement').fill(value);
  await page.locator(`[data-writing-action="replace-${all ? 'all' : 'one'}"]`).click();
  await page.waitForFunction(() => document.querySelector('#find-feedback').textContent.startsWith('已替换'));
}
async function undo() { await page.locator('[data-writing-action="undo"]').click(); await page.waitForTimeout(120); }
async function saveText() { await action('save'); return fs.readFile(documentPath, 'utf8'); }
async function setting(id, value) {
  if (!(await page.locator('#style-panel').isVisible())) await action('style');
  await page.locator(`#${id}`).setChecked(value); await action('style');
}
async function spellingEnabled(expected) {
  await app.evaluate(async ({ session }, expected) => {
    for (let i = 0; i < 100; i++) { if (session.defaultSession.isSpellCheckerEnabled() === expected) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Spellchecker preference was not applied');
  }, expected);
}

async function dragSelection(mode) {
  await page.locator(`[data-mode="${mode}"]`).click();
  await idle();
  const content = page.locator(mode === 'visual' ? '.ProseMirror' : '#source-editor .cm-content');
  await content.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press(startKey);
  const target = content.locator(mode === 'visual' ? ':scope > p' : '.cm-line').filter({ hasText: '拖选检查：' }).first();
  await target.scrollIntoViewIfNeeded();
  // A mode switch restores its editor's selection asynchronously. Establish a
  // real caret, then wait for the model-backed counter before starting a new
  // drag; a momentarily collapsed DOM range alone can still be the old selection.
  await target.click({ position: { x: 3, y: 5 } });
  await page.waitForFunction(() => getSelection()?.isCollapsed && document.querySelector('#selection-count').hidden);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const points = await target.evaluate(node => {
    const text = node.firstChild, glyphs = [];
    for (let index = 0; index < text.length; index++) {
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect(); glyphs.push({ index, left: rect.left, right: rect.right, y: (rect.top + rect.bottom) / 2 });
    }
    const first = glyphs[2], secondLine = glyphs.find(glyph => glyph.y > first.y + 5);
    if (!secondLine) throw new Error('Drag fixture must wrap over multiple lines');
    const last = glyphs[secondLine.index + 10];
    return { first, last, expected: text.textContent.slice(first.index, last.index + 1) };
  });
  // Start outside the editor so focus transfer cannot clear the drag guard.
  await page.locator(`[data-mode="${mode}"]`).focus();
  const scroll = page.locator(mode === 'visual' ? '#document-scroll' : '#source-editor .cm-scroller');
  const before = await scroll.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight }));
  await page.mouse.move(points.first.left + .2, points.first.y); await page.mouse.down();
  // Give the initial collapsed selection time to run any pending caret-centering frame.
  await page.waitForTimeout(100);
  await page.mouse.move(points.last.right - .2, points.last.y, { steps: 12 });
  await page.waitForTimeout(100); await page.mouse.up(); await page.waitForTimeout(100);
  const after = await scroll.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight }));
  selections.push({ mode, typewriter: await page.locator('body').evaluate(node => node.classList.contains('typewriter-mode')), before, after });
  assert.ok(Math.abs(after.top - before.top) < 1, `${mode} drag must not move the page: ${JSON.stringify({ before, after })}`);
  assert.equal(after.height, before.height, `${mode} selection must not change document height`);
  assert.equal(await page.evaluate(() => getSelection().toString()), points.expected, `${mode} drag must retain the intended text range`);
  assert.equal(await page.locator('.milkdown-toolbar').count(), 0, 'text selection must not mount a floating format toolbar');
  await page.screenshot({ path: path.join(run, `selection-${mode}-${selections.length}.png`) });
  return points.expected;
}

try {
  await launch();
  for (const typewriter of [false, true]) {
    await setting('typewriter', typewriter);
    for (const mode of ['visual', 'source']) await dragSelection(mode);
  }
  await setting('typewriter', false);
  const selected = await dragSelection('visual');
  assert.equal(await saveText(), selectionFixture, 'dragging text must preserve original BOM/CRLF bytes');
  await page.locator('[data-format="bold"]').click();
  assert.equal(await page.locator('.ProseMirror strong').filter({ hasText: selected }).textContent(), selected);
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+i`);
  assert.equal(await page.locator('.ProseMirror em').filter({ hasText: selected }).textContent(), selected);
  await page.keyboard.press(`${mod}+z`);
  await fs.writeFile(documentPath, original);
  await action('reload-document');
  await page.waitForFunction(() => document.querySelector('.ProseMirror h1')?.textContent === 'Writing test');
  record('native multi-line drag keeps text and scroll stable in both modes, with typewriter on/off; toolbar formatting and shortcuts remain available');

  await page.locator('.ProseMirror').click(); await page.keyboard.press(`${mod}+f`);
  await page.waitForFunction(() => document.activeElement?.id === 'find-query');
  await search('Bold joined text', { total: 1 });
  assert.equal(await page.locator('.moye-search-current').count() >= 2, true);
  assert.equal(await saveText(), original);
  record('visual keyboard find spans inline formatting without changing file bytes');

  await search('cat', { total: 8 });
  await page.locator('#find-word').check(); await found(3);
  await page.locator('#find-case').check(); await found(2);
  const before = await page.locator('#find-count').textContent();
  await page.locator('#find-query').press('Enter');
  assert.notEqual(await page.locator('#find-count').textContent(), before);
  await page.locator('#find-query').press('Shift+Enter');
  assert.equal(await page.locator('#find-count').textContent(), before);
  await search('[', { regex: true });
  await page.waitForFunction(() => document.querySelector('#find-feedback').textContent.includes('正则表达式无效'));
  assert.equal(await page.locator('#find-query').getAttribute('aria-invalid'), 'true');
  record('case, Unicode whole-word, navigation and invalid regex feedback work in visual mode');

  await search('Bold joined text', { total: 1 });
  await replace('Joined sentence');
  assert.ok((await saveText()).includes('Joined sentence'));
  assert.equal(await page.locator('.ProseMirror strong').filter({ hasText: 'untouched' }).count(), 1);
  await page.locator('[data-mode="source"]').click(); await page.locator('[data-mode="visual"]').click();
  await undo();
  assert.equal(await page.locator('.ProseMirror strong').filter({ hasText: 'joined' }).count(), 1);
  record('visual single replace preserves surrounding formatting and undo survives a no-edit mode round trip');

  await search('item-(\\d+)', { regex: true, total: 2 });
  await replace('number-$1', true); assert.ok((await saveText()).includes('number-12 number-34'));
  await undo(); assert.ok((await saveText()).includes('item-12 item-34'));
  await search('x+1', { total: 2 }); await replace('x+2', true);
  const formulas = await saveText(); assert.ok(formulas.includes('$x+2$')); assert.ok(formulas.includes('$$\r\nx+2\r\n$$'));
  await undo(); const restored = await saveText(); assert.ok(restored.includes('$x+1$')); assert.ok(restored.includes('$$\r\nx+1\r\n$$'));
  assert.ok(restored.startsWith('\uFEFF---\r\ntitle: hidden-cat\r\n---\r\n'));
  assert.ok(restored.includes('<span>raw-token</span>'));
  record('visual replace-all is one undo step, including TeX nodes, with frontmatter and raw HTML preserved');

  await search('中文 two words', { total: 1 });
  await page.waitForFunction(() => document.querySelector('#selection-count').textContent === '选中 4 字');
  await action('find-close');
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').click(); await page.keyboard.press(`${mod}+f`);
  await page.waitForFunction(() => document.activeElement?.id === 'find-query');
  assert.equal(await page.locator('#source-editor .cm-search').count(), 0);
  await search('title: hidden-cat', { total: 1 });
  await search('item-(\\d+)', { regex: true, total: 2 });
  await replace('source-$1', true); assert.ok((await saveText()).includes('source-12 source-34'));
  await undo(); assert.ok((await saveText()).includes('item-12 item-34'));
  await search('(?=item-)', { regex: true, total: 2 }); await replace('prefix-', true);
  assert.ok((await saveText()).includes('prefix-item-12 prefix-item-34'));
  await undo(); assert.ok(!(await saveText()).includes('prefix-item'));
  await search('中文 two words', { total: 1 });
  await page.waitForFunction(() => document.querySelector('#selection-count').textContent === '选中 4 字');
  record('source keyboard find uses unified UI, searches metadata, replaces captures and zero-width matches with undo');

  const started = Date.now();
  await search('(a+)+$', { regex: true });
  await page.waitForFunction(() => document.querySelector('#find-feedback').textContent.includes('耗时过长'), null, { timeout: 5000 });
  assert.ok(Date.now() - started < 5000);
  await search('中文', { total: 1 }); await action('find-close');
  record('pathological regex is terminated and subsequent search stays responsive');

  await setting('paragraph-focus', true); await setting('typewriter', true);
  const source = page.locator('#source-editor .cm-content');
  await source.click(); await page.keyboard.press(endKey); await page.keyboard.insertText('\nSource typing');
  await page.waitForTimeout(200);
  assert.ok(await page.locator('#source-editor .moye-current-paragraph').count() > 0);
  assert.ok(await page.locator('#source-editor .moye-inactive-paragraph').count() > 0);
  const sourceCenter = await page.locator('#source-editor .cm-cursor').first().evaluate(cursor => {
    const area = document.querySelector('#source-editor .cm-scroller').getBoundingClientRect();
    const bounds = cursor.getBoundingClientRect(); return (bounds.top + bounds.height / 2 - area.top) / area.height;
  });
  assert.ok(sourceCenter > .35 && sourceCenter < .57, `Source cursor ratio ${sourceCenter}`);
  await page.locator('[data-mode="visual"]').click();
  const rich = page.locator('.ProseMirror'); await rich.locator(':scope > p').last().click();
  await page.keyboard.press(endKey); await page.keyboard.insertText(' Visual typing');
  await page.waitForTimeout(200);
  assert.equal(await rich.locator('.moye-current-paragraph').count(), 1);
  assert.ok(await rich.locator('.moye-inactive-paragraph').count() > 5);
  const centered = await page.evaluate(() => {
    const range = getSelection().getRangeAt(0), cursor = range.getBoundingClientRect(), area = document.querySelector('#document-scroll').getBoundingClientRect();
    return (cursor.top + cursor.height / 2 - area.top) / area.height;
  });
  assert.ok(centered > .35 && centered < .57, `Visual cursor ratio ${centered}`);
  await page.screenshot({ path: path.join(run, 'writing-focus.png') });
  await page.emulateMedia({ media: 'print' });
  assert.equal(await rich.locator('.moye-inactive-paragraph').first().evaluate(node => getComputedStyle(node).opacity), '1');
  assert.equal(await page.locator('#visual-editor').evaluate(node => getComputedStyle(node).paddingTop), '0px');
  await page.emulateMedia({ media: 'screen' });
  await action('export-html');
  const html = await fs.readFile(htmlPath, 'utf8'); assert.ok(!html.includes('moye-inactive-paragraph')); assert.ok(!html.includes('typewriter-mode'));
  record('source and visual typewriter center the caret; paragraph focus stays out of HTML/PDF styling');

  await setting('spellcheck', true);
  assert.equal(await rich.evaluate(node => node.spellcheck), true);
  await spellingEnabled(true);
  assert.equal(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()), true);
  await page.locator('[data-mode="source"]').click();
  await page.waitForFunction(() => document.querySelector('#source-editor .cm-content').spellcheck);
  await saveText(); await exit(); await launch();
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('typewriter-mode') && node.classList.contains('paragraph-focus-mode')), true);
  assert.equal(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()), true);
  await setting('spellcheck', false);
  await spellingEnabled(false);
  assert.equal(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()), false);
  assert.equal(await page.locator('.ProseMirror').evaluate(node => node.spellcheck), false);
  record('spellcheck applies to both editors and writing settings persist across process restart');
  await page.locator('[data-mode="visual"]').click();
  await page.locator('.ProseMirror').click(); await page.keyboard.press(mac ? 'Meta+Alt+f' : 'Control+h');
  await page.waitForSelector('#replace-row', { state: 'visible' });
  await search('Writing test', { total: 1 }); await action('new'); await found(0, 0);
  assert.equal(await page.locator('[data-writing-action="replace-all"]').isDisabled(), true);
  await action('find-close'); await page.locator('.ProseMirror').click(); await page.keyboard.insertText('Fresh document');
  assert.ok(!(await fs.readFile(documentPath, 'utf8')).includes('Fresh document'));
  record('replace shortcut opens the unified panel and changing documents invalidates stale search results');
  await page.locator('[data-mode="source"]').click();
  await action('find'); await search('Fresh document', { total: 1 });
  const freshTab = await page.locator('.document-tab.active [role="tab"]').getAttribute('data-document-id');
  const originalTab = await page.locator('.document-tab [role="tab"]').evaluateAll((nodes, active) => nodes.find(node => node.dataset.documentId !== active).dataset.documentId, freshTab);
  async function activate(id) { await page.locator(`.document-tab [role="tab"][data-document-id="${id}"]`).click(); await idle(); }
  await page.locator('#source-editor .cm-content').focus(); await page.keyboard.press(endKey);
  await activate(originalTab); await found(0, 0); await action('find-close');
  await activate(freshTab);
  assert.equal(await page.locator('#source-editor .moye-search-hit').count(), 0);
  await action('find'); await search('Fresh document', { total: 1 });
  await page.locator('#source-editor .cm-content').focus(); await page.keyboard.press(endKey);
  await activate(originalTab); await found(0, 0);
  await activate(freshTab); await found(1);
  await page.locator('#source-editor .cm-content').focus(); await page.keyboard.insertText(' at-restored-caret');
  assert.match(await page.locator('#source-editor .cm-content').innerText(), /Fresh document\s+at-restored-caret\s*$/);
  await action('find-close');
  record('tab switches invalidate active search, clear restored inactive highlights and preserve each source caret');
  assert.deepEqual(errors, []); record('no renderer exceptions');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
    await fs.writeFile(path.join(run, 'last-state.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
  }
  throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors, selections }, null, 2));
  await exit(); console.log(`Evidence: ${run}`);
}

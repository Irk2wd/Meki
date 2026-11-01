const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore, DEFAULT_SETTINGS, validateSettings, isWithin } = require('../electron/file-store.cjs');

test('heading numbering follows actual ancestors, handles skipped levels and restarts per document', async () => {
  const { numberHeadings, numberedHeadingTitle } = await import('../src/heading-numbering.ts');
  assert.deepEqual(numberHeadings([1, 2, 3, 2, 6, 1, 4]), ['1', '1.1', '1.1.1', '1.2', '1.2.1', '2', '2.1']);
  assert.deepEqual(numberHeadings([3, 6, 3, 2, 4, 1]), ['1', '1.1', '2', '3', '3.1', '4']);
  assert.deepEqual(numberHeadings([]), []); assert.deepEqual(numberHeadings([6]), ['1']);
  assert.equal(numberedHeadingTitle('', '1.1'), '1.1 未命名标题');
  assert.throws(() => numberHeadings([0]), /1 to 6/);
});

test('numbered HTML and TOC share labels while keeping heading IDs and source untouched', async () => {
  const { renderMarkdown } = await import('../src/markdown-render.ts');
  const markdown = '\uFEFF---\r\ntitle: unchanged\r\n---\r\n\r\n[TOC]\r\n\r\n### Same\r\n\r\n###### Deep\r\n\r\n### Same\r\n\r\n#\r\n\r\n```md\r\n# Not a heading\r\n```\r\n';
  const before = renderMarkdown(markdown).html, numbered = renderMarkdown(markdown, { headingNumbering: true }).html;
  const ids = html => [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids(numbered), ids(before)); assert.equal(new Set(ids(numbered)).size, 4);
  assert.deepEqual([...numbered.matchAll(/data-heading-number="([^"]+)"/g)].map(match => match[1]), ['1', '1.1', '2', '3']);
  assert.match(numbered, />1 Same<\/a>/); assert.match(numbered, />1\.1 Deep<\/a>/); assert.match(numbered, />2 Same<\/a>/); assert.match(numbered, />3 未命名标题<\/a>/);
  assert.equal(renderMarkdown(markdown).html, before); assert.ok(!before.includes('data-heading-number'));
  assert.deepEqual([...renderMarkdown('# Fresh', { headingNumbering: true }).html.matchAll(/data-heading-number="([^"]+)"/g)].map(match => match[1]), ['1']);
});

test('heading numbering defaults off, validates and persists independently of older settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-headings-'));
  t.after(async () => { assert.ok(isWithin(root, os.tmpdir()) && path.basename(root).startsWith('meki-headings-')); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(DEFAULT_SETTINGS.headingNumbering, false);
  assert.throws(() => validateSettings({ headingNumbering: 'true' }), /headingNumbering/);
  const store = new FileStore(root); await store.init(); await store.updateSettings({ headingNumbering: true, theme: 'night' });
  const reopened = new FileStore(root); await reopened.init(); assert.equal(reopened.metadata.settings.headingNumbering, true); assert.equal(reopened.metadata.settings.theme, 'night');
});

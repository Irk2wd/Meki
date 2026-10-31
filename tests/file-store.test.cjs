'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  FileStore, RevisionConflictError, DEFAULT_SETTINGS, validateAbsolutePath, validateDocument,
  validateSettings, atomicWrite, MAX_IMAGE_BYTES, MAX_THEME_BYTES,
} = require('../electron/file-store.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moye-store-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  const documents = path.join(root, 'documents');
  await fs.mkdir(documents);
  const store = new FileStore(userData);
  await store.init();
  return { root, userData, documents, store };
}

const create = (filePath, content) => ({ path: filePath, name: path.basename(filePath), content, revision: null });
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp2cAAAAASUVORK5CYII=', 'base64');

test('Unicode Markdown, math, blank final lines, and non-ASCII paths round-trip', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, '论文 草稿.md');
  const content = '# 墨页\n\n行内 $E=mc^2$ 与 emoji 🖋️\n\n$$\n\\int_0^1 x^2\\,dx=\\frac13\n$$\n\n';
  const saved = await store.saveDocument(create(filePath, content));
  assert.equal(saved.content, content);
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(saved.revision, crypto.createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(await store.readDocument(filePath), saved);
  assert.equal(await fs.readFile(filePath, 'utf8'), content);
  assert.deepEqual((await fs.readdir(documents)).filter((name) => name.endsWith('.tmp')), []);
});

test('unchanged save retains UTF-8 BOM and mixed line endings byte-for-byte', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, '原始.md');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r\n\r\n第一行\n第二行\r\n')]);
  await fs.writeFile(filePath, original);
  const document = await store.readDocument(filePath);
  assert.equal(document.content, '# 标题\n\n第一行\n第二行\n');
  await store.saveDocument(document);
  assert.deepEqual(await fs.readFile(filePath), original);
});

test('edited CRLF document retains its BOM and CRLF convention, including Save As', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, 'windows.md');
  await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]));
  const document = await store.readDocument(filePath);
  const saved = await store.saveDocument({ ...document, content: 'one\ntwo\nthree\n' });
  assert.deepEqual(await fs.readFile(filePath), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\nthree\r\n')]));
  const otherPath = path.join(documents, 'copied.md');
  await store.saveDocument(create(otherPath, saved.content), { formatFrom: filePath });
  assert.deepEqual(await fs.readFile(otherPath), await fs.readFile(filePath));
});

test('external modification or deletion produces a conflict without losing either file contents or edits', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, 'conflict.md');
  await fs.writeFile(filePath, 'Original\n');
  const original = await store.readDocument(filePath);
  const edited = { ...original, content: 'My changes\n' };
  await fs.writeFile(filePath, 'Other application\n');
  await assert.rejects(store.saveDocument(edited), RevisionConflictError);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'Other application\n');
  assert.equal(edited.content, 'My changes\n');
  const saved = await store.saveDocument(edited, { overwrite: true });
  assert.equal(await fs.readFile(filePath, 'utf8'), 'My changes\n');
  await fs.unlink(filePath);
  await assert.rejects(store.saveDocument({ ...saved, content: 'After deletion\n' }), RevisionConflictError);
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('new-file saves refuse to overwrite an existing file without explicit permission', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, 'existing.md');
  await fs.writeFile(filePath, 'Do not erase');
  await assert.rejects(store.saveDocument(create(filePath, 'Replacement')), RevisionConflictError);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'Do not erase');
});

test('a failed commit keeps the original file and removes its temporary file', async (t) => {
  const { documents } = await fixture(t);
  const filePath = path.join(documents, 'keep.md');
  await fs.writeFile(filePath, 'Before');
  await assert.rejects(atomicWrite(filePath, Buffer.from('After'), { beforeCommit: () => { throw new Error('simulated write interruption'); } }), /simulated write interruption/);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'Before');
  assert.deepEqual(await fs.readdir(documents), ['keep.md']);
});

test('competing saves cannot silently overwrite a completed save', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, 'concurrent.md');
  const initial = await store.saveDocument(create(filePath, 'Start'));
  const results = await Promise.allSettled([
    store.saveDocument({ ...initial, content: 'First' }),
    store.saveDocument({ ...initial, content: 'Second' }),
  ]);
  // realpath resolution can complete in either order; only one stale-revision save may commit.
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal(await fs.readFile(filePath, 'utf8'), ['First', 'Second'][winner]);
});

test('recovery survives restart, preserves Unicode and math, and can be cleared', async (t) => {
  const { userData, store } = await fixture(t);
  const draft = { path: null, name: '未命名.md', revision: null, content: '恢复 📝\n$$x^2$$\n', updatedAt: Date.now() };
  await store.saveDraft(draft);
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.deepEqual(await reopened.loadDraft(), draft);
  await reopened.saveDraft(null);
  assert.equal(await reopened.loadDraft(), null);
});

test('draft writes are ordered and malformed recovery is retained for manual recovery', async (t) => {
  const { userData, store } = await fixture(t);
  const first = { path: null, name: 'Draft.md', revision: null, content: 'First', updatedAt: 1 };
  await Promise.all([store.saveDraft(first), store.saveDraft({ ...first, content: 'Second', updatedAt: 2 })]);
  assert.equal((await store.loadDraft()).content, 'Second');
  const draftPath = path.join(userData, 'recovery.json');
  await fs.writeFile(draftPath, '{bad json');
  assert.equal(await store.loadDraft(), null);
  assert.equal(await fs.readFile(draftPath, 'utf8'), '{bad json');
  await assert.rejects(store.saveDraft({ ...first, updatedAt: 'today' }), /timestamp/);
  await assert.rejects(store.saveDraft({ ...first, path: '../outside.md' }), /absolute/);
});

test('settings persist validated values and reject unexpected IPC fields', async (t) => {
  const { userData, store } = await fixture(t);
  assert.deepEqual(store.metadata.settings, DEFAULT_SETTINGS);
  const settings = validateSettings({ theme: 'night', fontSize: 20, focus: true }, DEFAULT_SETTINGS);
  await store.updateMetadata({ settings });
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.deepEqual(reopened.metadata.settings, settings);
  for (const invalid of [{ theme: 'unknown' }, { fontSize: Infinity }, { fontSize: 7 }, { lineWidth: 200 }, { focus: 'yes' }, { arbitrary: true }]) {
    assert.throws(() => validateSettings(invalid), /Invalid setting/);
  }
});

test('rapid independent settings changes retain both updates', async (t) => {
  const { userData, store } = await fixture(t);
  await Promise.all([store.updateSettings({ theme: 'linen' }), store.updateSettings({ fontSize: 21 })]);
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.equal(reopened.metadata.settings.theme, 'linen');
  assert.equal(reopened.metadata.settings.fontSize, 21);
});

test('0.1 profiles receive new defaults without changing their existing appearance', async (t) => {
  const { userData } = await fixture(t);
  const legacySettings = { theme: 'linen', font: 'sans', fontSize: 22, lineWidth: 900, focus: true, sidebar: false };
  await fs.writeFile(path.join(userData, 'state.json'), JSON.stringify({ settings: legacySettings }));
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.deepEqual(reopened.metadata.settings, { ...DEFAULT_SETTINGS, ...legacySettings });
});

test('invalid saved theme options fall back independently while valid preferences survive', async (t) => {
  const { userData } = await fixture(t);
  await fs.writeFile(path.join(userData, 'state.json'), JSON.stringify({ settings: {
    theme: 'night', fontSize: 21, customCss: 42, fontFamily: 'Arial; color:red',
    mathNumbering: 'unknown', mathPhysics: 'yes', futureSetting: true,
  } }));
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.deepEqual(reopened.metadata.settings, { ...DEFAULT_SETTINGS, theme: 'night', fontSize: 21 });
});

test('custom theme, local font and math settings persist with independent concurrent updates', async (t) => {
  const { userData, store } = await fixture(t);
  const customCss = '/* 自定义主题 */\r\n.meki-document { color: #123456; }\r\n';
  await Promise.all([
    store.updateSettings({ customCss, fontFamily: '  Noto Sans CJK SC  ' }),
    store.updateSettings({ mathNumbering: 'ams', mathPhysics: true }),
  ]);
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.equal(reopened.metadata.settings.customCss, customCss);
  assert.equal(reopened.metadata.settings.fontFamily, 'Noto Sans CJK SC');
  assert.equal(reopened.metadata.settings.mathNumbering, 'ams');
  assert.equal(reopened.metadata.settings.mathPhysics, true);
  assert.equal((await reopened.updateSettings({ mathNumbering: 'all' })).mathNumbering, 'all');
  assert.equal((await reopened.updateSettings({ customCss: '', fontFamily: '', mathNumbering: 'none', mathPhysics: false })).customCss, '');
});

test('theme and font bounds reject oversize UTF-8, CSS injection and invalid math modes', () => {
  const exactCss = 'x'.repeat(MAX_THEME_BYTES);
  assert.equal(validateSettings({ customCss: exactCss }).customCss.length, MAX_THEME_BYTES);
  assert.equal(validateSettings({ fontFamily: '  华文宋体  ' }).fontFamily, '华文宋体');
  for (const invalid of [
    { customCss: 'x'.repeat(MAX_THEME_BYTES + 1) }, { customCss: '中'.repeat(Math.floor(MAX_THEME_BYTES / 3) + 1) },
    { customCss: 'a\0b' }, { customCss: null }, { fontFamily: 'A'.repeat(129) },
    { fontFamily: 'Arial, sans-serif' }, { fontFamily: 'Arial; color: red' },
    { fontFamily: 'url(https://example.com/font)' }, { fontFamily: 'Arial\nbody' },
    { fontFamily: '"Arial"' }, { mathNumbering: 'AMS' }, { mathNumbering: true }, { mathPhysics: 1 },
  ]) assert.throws(() => validateSettings(invalid), /Invalid setting/);
});

test('a maximum-size CSS setting survives JSON escaping and restart', async (t) => {
  const { userData, store } = await fixture(t);
  const customCss = `/*${'\\'.repeat(MAX_THEME_BYTES - 4)}*/`;
  await store.updateSettings({ customCss, theme: 'linen' });
  assert.ok((await fs.stat(path.join(userData, 'state.json'))).size > MAX_THEME_BYTES);
  const reopened = new FileStore(userData);
  await reopened.init();
  assert.equal(reopened.metadata.settings.customCss, customCss);
  assert.equal(reopened.metadata.settings.theme, 'linen');
});

test('CSS import decodes UTF-8 BOM, preserves CSS text and does not change settings', async (t) => {
  const { documents, store } = await fixture(t);
  const filePath = path.join(documents, '墨色主题.CSS');
  const css = '/* 中文主题 */\r\n.meki-document { color: #334455; }\r\n';
  await fs.writeFile(filePath, `\uFEFF${css}`);
  assert.deepEqual(await store.readTheme(filePath), { name: '墨色主题.CSS', css });
  assert.deepEqual(store.metadata.settings, DEFAULT_SETTINGS);
  const emptyPath = path.join(documents, 'empty.css');
  await fs.writeFile(emptyPath, '');
  assert.deepEqual(await store.readTheme(emptyPath), { name: 'empty.css', css: '' });
});

test('CSS import rejects non-CSS paths, binary files, oversized files and directories', async (t) => {
  const { documents, store } = await fixture(t);
  await assert.rejects(store.readTheme(path.join(documents, 'theme.txt')), /CSS/);
  await assert.rejects(store.readTheme('relative.css'), /absolute/);
  const binaryPath = path.join(documents, 'binary.css');
  await fs.writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0, 0]));
  await assert.rejects(store.readTheme(binaryPath), /UTF-8/);
  const nulPath = path.join(documents, 'nul.css');
  await fs.writeFile(nulPath, 'body\0{}');
  await assert.rejects(store.readTheme(nulPath), /customCss/);
  const oversizedPath = path.join(documents, 'oversized.css');
  await fs.writeFile(oversizedPath, 'x'.repeat(MAX_THEME_BYTES + 1));
  await assert.rejects(store.readTheme(oversizedPath), /256 KiB/);
  const directoryPath = path.join(documents, 'directory.css');
  await fs.mkdir(directoryPath);
  await assert.rejects(store.readTheme(directoryPath), /regular file|EISDIR/);
});

test('opening a file symlink saves its target and preserves the link', async (t) => {
  const { documents, store } = await fixture(t);
  const target = path.join(documents, 'target.md');
  const link = path.join(documents, 'link.md');
  await fs.writeFile(target, 'Original');
  try { await fs.symlink(target, link, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create file symlinks.'); return; } throw error; }
  const opened = await store.readDocument(link);
  assert.equal(opened.path, await fs.realpath(target));
  await store.saveDocument({ ...opened, content: 'Saved through the link' });
  assert.equal(await fs.readFile(target, 'utf8'), 'Saved through the link');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('workspace traversal skips generated/dependency directories and stops at the file limit', async (t) => {
  const { documents, store } = await fixture(t);
  for (const directory of ['.git', 'node_modules', 'example.assets', 'notes']) await fs.mkdir(path.join(documents, directory));
  await Promise.all([
    fs.writeFile(path.join(documents, '.git', 'ignored.md'), 'git'),
    fs.writeFile(path.join(documents, 'node_modules', 'ignored.md'), 'dependency'),
    fs.writeFile(path.join(documents, 'example.assets', 'ignored.md'), 'asset'),
    fs.writeFile(path.join(documents, 'notes', '中文.md'), 'note'),
    fs.writeFile(path.join(documents, 'README.md'), 'readme'),
    fs.writeFile(path.join(documents, 'ignore.js'), 'code'),
  ]);
  const full = await store.readWorkspace(documents);
  assert.equal(full.entries.length, 2);
  assert.ok(full.entries.some((entry) => entry.relativePath === 'notes/中文.md'));
  const limited = await store.readWorkspace(documents, 1);
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.truncated, true);
});

test('attachments are unique relative image paths and local assets are embedded', async (t) => {
  const { documents, store } = await fixture(t);
  const documentPath = path.join(documents, '我的 文档.md');
  await store.saveDocument(create(documentPath, '# Images'));
  const relative = await store.saveAttachment({ documentPath, name: '../../figure (1).png', bytes: tinyPng });
  assert.match(relative, /^[^/]+\.assets\/figure%20%281%29-[a-f0-9]+\.png$/);
  assert.equal(relative.includes('..'), false);
  const actual = path.resolve(documents, decodeURIComponent(relative));
  assert.deepEqual(await fs.readFile(actual), tinyPng);
  const again = await store.saveAttachment({ documentPath, name: 'figure (1).png', bytes: tinyPng });
  assert.notEqual(relative, again);
  const url = await store.assetUrl(relative, documentPath);
  assert.equal(url, `data:image/png;base64,${tinyPng.toString('base64')}`);
  assert.equal(await store.assetUrl('https://example.com/image.png', documentPath), 'https://example.com/image.png');
  assert.equal(await store.assetUrl(url, documentPath), url);
});

test('image access rejects a path outside the trusted document directory and mismatched bytes', async (t) => {
  const { root, documents, store } = await fixture(t);
  const documentPath = path.join(documents, 'article.md');
  await store.saveDocument(create(documentPath, 'Text'));
  await fs.writeFile(path.join(root, 'outside.png'), tinyPng);
  assert.equal(await store.assetUrl('../outside.png', documentPath), '../outside.png');
  assert.match(await store.assetUrl('../outside.png', documentPath, root), /^data:image\/png;base64,/);
  await assert.rejects(store.saveAttachment({ documentPath, name: 'disguised.png', bytes: Buffer.from('private text') }), /valid PNG/);
  await assert.rejects(store.saveAttachment({ documentPath: null, name: 'image.png', bytes: tinyPng }), /absolute/);
  await assert.rejects(store.saveAttachment({ documentPath, name: 'too-big.png', bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) }), /20 MB/);
});

test('invalid or binary paths and documents fail before writing', async (t) => {
  const { documents, store } = await fixture(t);
  for (const value of ['', '../file.md', 'relative.md', `bad\0path`, null, 42]) assert.throws(() => validateAbsolutePath(value), /absolute/);
  const invalid = path.join(documents, 'invalid.md');
  await fs.writeFile(invalid, Buffer.from([0xff, 0xfe, 0, 0]));
  await assert.rejects(store.readDocument(invalid), /not UTF-8/);
  assert.throws(() => validateDocument({ ...create(path.join(documents, 'binary.md'), 'a\0b') }), /UTF-8/);
  assert.throws(() => validateDocument({ ...create(path.join(documents, 'code.exe'), 'text') }), /Markdown/);
  assert.throws(() => validateDocument({ ...create(path.join(documents, 'good.md'), 'text'), revision: 'guess' }), /revision/);
  await assert.rejects(store.saveDocument(create(documents, 'Overwrite folder')), /Markdown/);
});

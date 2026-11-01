const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore, isWithin } = require('../electron/file-store.cjs');
const { readSelectedImages } = require('../electron/image-input.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp2cAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'meki-media-')));
  t.after(async () => { assert.ok(isWithin(root, parent) && path.basename(root).startsWith('meki-media-')); await fs.rm(root, { recursive: true, force: true }); });
  const documentPath = path.join(root, '文 稿.md'); await fs.writeFile(documentPath, '# Hello');
  const store = new FileStore(path.join(root, 'profile')); await store.init();
  return { root, documentPath, store, assets: path.join(root, '文 稿.assets') };
}
test('image batches use unique relative paths and keep all original image bytes', async t => {
  const { store, documentPath, root } = await fixture(t);
  const paths = await store.saveAttachments({ documentPath, images: [{ name: '图 [A].png', bytes: png }, { name: '图 [A].png', bytes: png }] });
  assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
  for (const relative of paths) { assert.ok(!path.isAbsolute(relative)); assert.ok(relative.includes('%20')); assert.deepEqual(await fs.readFile(path.join(root, decodeURIComponent(relative))), png); }
});
test('batch validation happens before creating attachment files or directories', async t => {
  const { store, documentPath, assets } = await fixture(t);
  await assert.rejects(store.saveAttachments({ documentPath, images: [{ name: 'good.png', bytes: png }, { name: 'fake.png', bytes: Buffer.from('not a PNG') }] }), /valid PNG/);
  await assert.rejects(fs.stat(assets), { code: 'ENOENT' });
  await assert.rejects(store.saveAttachments({ documentPath, images: Array(33).fill({ name: 'a.png', bytes: png }) }), /32/);
  await assert.rejects(store.saveAttachments({ documentPath: null, images: [{ name: 'a.png', bytes: png }] }), /absolute/);
});
test('failed second image write rolls back only files created by the current batch', async t => {
  const { store, documentPath, assets } = await fixture(t);
  await fs.mkdir(assets); const existing = path.join(assets, 'keep.png'); await fs.writeFile(existing, png);
  const originalOpen = fs.open; let writes = 0;
  fs.open = async function(file, flags, ...rest) {
    if (path.dirname(file) === assets && flags === 'wx' && ++writes === 2) throw new Error('simulated full disk');
    return originalOpen.call(this, file, flags, ...rest);
  };
  try { await assert.rejects(store.saveAttachments({ documentPath, images: [{ name: 'a.png', bytes: png }, { name: 'b.png', bytes: png }] }), /full disk/); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(await fs.readdir(assets), ['keep.png']); assert.deepEqual(await fs.readFile(existing), png);
});
test('native image selection only reads bounded supported files', async t => {
  const { root } = await fixture(t); const image = path.join(root, '选择.png'); await fs.writeFile(image, png);
  const selected = await readSelectedImages([image]); assert.equal(selected[0].name, '选择.png'); assert.deepEqual(selected[0].bytes, png);
  await assert.rejects(readSelectedImages([path.join(root, 'file.txt')]), /图片/);
  await assert.rejects(readSelectedImages(['relative.png']), /图片/);
  await assert.rejects(readSelectedImages(Array(33).fill(image)), /32/);
});

test('native image reads reject files that grow between stat and read', async t => {
  const { root } = await fixture(t), image = path.join(root, 'changing.png'); await fs.writeFile(image, png);
  const originalOpen = fs.open;
  fs.open = async function(filePath, ...args) {
    const handle = await originalOpen.call(this, filePath, ...args);
    if (filePath === image) {
      const originalStat = handle.stat.bind(handle); let first = true;
      handle.stat = async (...statArgs) => { const info = await originalStat(...statArgs); if (first) { first = false; await fs.appendFile(image, Buffer.alloc(1024)); } return info; };
    }
    return handle;
  };
  try { await assert.rejects(readSelectedImages([image]), /正在被修改/); } finally { fs.open = originalOpen; }
});
test('outline follows the Markdown structure, full heading levels, metadata offsets and duplicate titles', async () => {
  const { buildOutline, visibleOutline } = await import('../src/outline.ts');
  const markdown = '\uFEFF---\r\ntitle: ignored\r\n---\r\n\r\n# A\r\n\r\n### **B**\r\n\r\n###### C\r\n\r\n```md\r\n# Fake\r\n```\r\n\r\n# A\r\n\r\nSetext\r\n------\r\n';
  const entries = buildOutline(markdown);
  assert.deepEqual(entries.map(({ level, text, parent }) => [level, text, parent]), [[1, 'A', -1], [3, 'B', 0], [6, 'C', 1], [1, 'A', -1], [2, 'Setext', 3]]);
  assert.notEqual(entries[0].id, entries[3].id);
  assert.equal(markdown.slice(entries[1].offset, entries[1].offset + 3), '###');
  assert.deepEqual(visibleOutline(entries, new Set([entries[0].id])), [true, false, false, true, true]);
  assert.deepEqual(visibleOutline(entries, new Set([entries[1].id])), [true, true, false, true, true]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AttachmentStore } = require('../electron/attachment-store.cjs');
const { FileStore, digest, validateSettings } = require('../electron/file-store.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'moye-image-management-')));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('moye-image-management-')); await fs.rm(root, { recursive: true, force: true }); });
  const folder = path.join(root, 'notes'); await fs.mkdir(folder); const documentPath = path.join(folder, 'Draft.md'), raw = Buffer.from('\uFEFF# Draft\r\n');
  await fs.writeFile(documentPath, raw); await fs.writeFile(path.join(folder, 'source.png'), png);
  const settings = () => ({ imageDirectoryBase: 'workspace', imageDirectory: 'media/${filename}' });
  const store = new AttachmentStore({ authorize: value => { assert.equal(value, documentPath); return value; }, boundary: async () => root, workspace: () => root, settings, ...options });
  const input = { documentPath, revision: digest(raw), sources: ['source.png'] };
  return { root, folder, documentPath, raw, store, input, settings };
}
test('insertion and organization share the same workspace-relative directory setting', async t => {
  const f = await fixture(t), fileStore = new FileStore(path.join(f.root, 'profile')); await fileStore.init();
  await fileStore.updateSettings(f.settings());
  const inserted = await fileStore.saveAttachments({ documentPath: f.documentPath, images: [{ name: 'insert.png', bytes: png }] }, f.root);
  assert.match(inserted[0], /^\.\.\/media\/Draft\//);
  const plan = await f.store.prepare(f.input); assert.equal(plan.target, path.join(f.root, 'media', 'Draft'));
  const mapping = await f.store.commit(plan.id); await f.store.finish(plan.id, true);
  assert.match(mapping[0].relativePath, /^\.\.\/media\/Draft\//);
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'source.png')), png); assert.deepEqual(await fs.readFile(f.documentPath), f.raw);
  assert.throws(() => validateSettings({ imageDirectory: '../outside' }));
});
test('a named image copy preserves the source and refuses to overwrite an existing destination', async t => {
  const f = await fixture(t), input = { ...f.input, destination: { base: 'document', directory: 'chosen' }, name: 'Figure 1.png' };
  const plan = await f.store.prepare(input), mapping = await f.store.commit(plan.id); await f.store.finish(plan.id, true);
  assert.equal(mapping[0].relativePath, 'chosen/Figure%201.png'); assert.deepEqual(await fs.readFile(path.join(f.folder, 'source.png')), png);
  const again = await f.store.prepare(input); await assert.rejects(f.store.commit(again.id), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'chosen', 'Figure 1.png')), png);
  await assert.rejects(f.store.prepare({ ...input, name: 'Figure.jpg' }), /扩展名/);
  const sameFolder = await f.store.prepare({ ...f.input, sources: ['chosen/Figure%201.png'], destination: input.destination });
  assert.equal(sameFolder.count, 1); assert.equal(sameFolder.reused, 0);
  const fresh = await f.store.commit(sameFolder.id); await f.store.finish(sameFolder.id, true);
  assert.notEqual(fresh[0].relativePath, 'chosen/Figure%201.png');
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'chosen', 'Figure 1.png')), png);
});
test('network copies download only when explicitly requested and preserve URL query identity', async t => {
  let count = 0;
  const f = await fixture(t, { download: async source => { assert.equal(source, 'https://example.test/asset?id=1'); count++; return { bytes: png, extension: '.png', name: 'asset.png' }; } });
  const input = { ...f.input, sources: ['https://example.test/asset?id=1'] };
  const skipped = await f.store.prepare(input); assert.equal(skipped.remote, 1); assert.equal(count, 0);
  await f.store.finish(skipped.id, false);
  const plan = await f.store.prepare({ ...input, download: true }); assert.equal(count, 1);
  const mapping = await f.store.commit(plan.id); await f.store.finish(plan.id, true);
  assert.equal(mapping[0].source, input.sources[0]); assert.ok(!mapping[0].relativePath.includes('?'));
  assert.deepEqual(await fs.readFile(path.resolve(f.folder, decodeURIComponent(mapping[0].relativePath))), png);
});
test('canceling a download or externally changing the document writes no image files', async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { download: (_source, { signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(Error('Canceled')), { once: true }); }) });
  const pending = f.store.prepare({ ...f.input, sources: ['https://example.test/picture'], download: true });
  await began; f.store.cancel(); await assert.rejects(pending, /Canceled/); await assert.rejects(fs.stat(path.join(f.root, 'media')), { code: 'ENOENT' });
  f.store.download = async () => { await fs.writeFile(f.documentPath, 'external'); return { bytes: png, extension: '.png', name: 'x.png' }; };
  await assert.rejects(f.store.prepare({ ...f.input, sources: ['https://example.test/picture'], download: true }), /其他程序修改/);
  await assert.rejects(fs.stat(path.join(f.root, 'media')), { code: 'ENOENT' });
});

test('insertion rolls back its own partial writes and newly created empty directories', async t => {
  const f = await fixture(t), fileStore = new FileStore(path.join(f.root, 'profile')); await fileStore.init();
  await fileStore.updateSettings({ imageDirectory: 'nested/target' });
  const originalOpen = fs.open; let output;
  fs.open = async function(file, flags, ...rest) {
    const handle = await originalOpen.call(this, file, flags, ...rest);
    if (flags === 'wx' && path.dirname(file) === path.join(f.folder, 'nested', 'target')) {
      output = file; const originalWrite = handle.write.bind(handle); let first = true;
      handle.write = async (...args) => { if (!first) throw new Error('simulated full disk'); first = false; return originalWrite(args[0], args[1], 8, args[3]); };
    }
    return handle;
  };
  try { await assert.rejects(fileStore.saveAttachments({ documentPath: f.documentPath, images: [{ name: 'picture.png', bytes: png }] }), /full disk/); }
  finally { fs.open = originalOpen; }
  assert.ok(output); await assert.rejects(fs.stat(path.join(f.folder, 'nested')), { code: 'ENOENT' });
});

test('insertion refuses an authorized document path whose parent became a junction', async t => {
  const f = await fixture(t), fileStore = new FileStore(path.join(f.root, 'profile')); await fileStore.init();
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'Draft.md'), f.raw);
  await fs.rename(f.folder, f.folder + '-original');
  await fs.symlink(outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(fileStore.saveAttachments({ documentPath: f.documentPath, images: [{ name: 'picture.png', bytes: png }] }), /授权位置|链接/);
  assert.deepEqual(await fs.readdir(outside), ['Draft.md']);
});

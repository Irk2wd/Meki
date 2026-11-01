const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { AttachmentStore } = require('../electron/attachment-store.cjs');
const { digest, pathKey } = require('../electron/file-store.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meki-attachments-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const doc = path.join(root, '笔记.md'), raw = Buffer.from('\uFEFF# 文稿\r\n\r\nOriginal disk bytes.\r\n'), picture = path.join(root, '原 图.png'), target = path.join(root, '笔记.assets');
  await fs.writeFile(doc, raw); await fs.writeFile(picture, png);
  const authorize = value => { assert.equal(pathKey(value), pathKey(doc), 'document must already be authorized'); return value; };
  const store = new AttachmentStore({ authorize, boundary: async () => root, ...options });
  const prepare = sources => store.prepare({ documentPath: doc, revision: digest(raw), sources });
  return { root, doc, raw, picture, target, store, prepare };
}

test('preview does not write; commit deduplicates canonical sources, preserves Unicode/suffixes and original bytes', async t => {
  const f = await fixture(t);
  const sources = ['原%20图.png?size=1#crop', pathToFileURL(f.picture).href + '#second', './原%20图.png', 'https://example.com/remote.png'];
  const plan = await f.prepare(sources);
  assert.equal(plan.count, 1); assert.equal(plan.remote, 1); assert.equal(plan.bytes, png.length); assert.equal(plan.target, f.target);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const mapping = await f.store.commit(plan.id); assert.equal(mapping.length, 3);
  assert.equal(mapping[0].relativePath.split(/[?#]/)[0], mapping[1].relativePath.split(/[?#]/)[0]);
  assert.match(mapping[0].relativePath, /\?size=1#crop$/); assert.match(mapping[1].relativePath, /#second$/);
  assert.deepEqual(await fs.readFile(path.resolve(f.root, decodeURIComponent(mapping[2].relativePath))), png);
  assert.deepEqual(await fs.readFile(f.doc), f.raw); assert.deepEqual(await fs.readFile(f.picture), png);
  await f.store.finish(plan.id, true); assert.equal((await fs.readdir(f.target)).length, 1);
  await assert.rejects(f.store.commit(plan.id), /失效/);
});

test('embedded images deduplicate; already organized sources are reused without new copies', async t => {
  const f = await fixture(t); const embedded = `data:image/png;base64,${png.toString('base64')}`;
  const plan = await f.prepare([embedded, embedded, embedded + '#view']); assert.equal(plan.count, 1);
  const mapping = await f.store.commit(plan.id); assert.equal(mapping[1].relativePath, mapping[0].relativePath + '#view'); await f.store.finish(plan.id, true);
  const next = await f.prepare([mapping[0].relativePath, pathToFileURL(path.join(f.root, decodeURIComponent(mapping[0].relativePath))).href]);
  assert.equal(next.count, 0); assert.equal(next.reused, 1);
  const reused = await f.store.commit(next.id); assert.equal(reused[0].relativePath, mapping[0].relativePath); assert.equal(reused[1].relativePath, mapping[0].relativePath);
  await f.store.finish(next.id, true); assert.equal((await fs.readdir(f.target)).length, 1);
});

test('cancel before or after copy changes no Markdown and removes only the new copies', async t => {
  const f = await fixture(t); const preview = await f.prepare(['原%20图.png']); await f.store.finish(preview.id, false);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep.txt'), 'existing');
  const plan = await f.prepare(['原%20图.png']); await f.store.commit(plan.id); await f.store.finish(plan.id, false);
  assert.deepEqual(await fs.readdir(f.target), ['keep.txt']); assert.deepEqual(await fs.readFile(f.doc), f.raw); assert.deepEqual(await fs.readFile(f.picture), png);
});

test('a partial batch failure rolls back this batch but never overwrites existing attachments', async t => {
  const f = await fixture(t, { hooks: { afterCopy: async index => { if (index === 1) throw new Error('injected disk failure'); } } });
  await fs.writeFile(path.join(f.root, 'second.png'), png); await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep.png'), png);
  const plan = await f.prepare(['原%20图.png', 'second.png']); await assert.rejects(f.store.commit(plan.id), /injected disk failure/);
  assert.deepEqual(await fs.readdir(f.target), ['keep.png']); assert.deepEqual(await fs.readFile(path.join(f.target, 'keep.png')), png);
  assert.deepEqual(await fs.readFile(f.doc), f.raw);
});

test('exclusive creation preserves a conflicting target introduced after preview and directory checks', async t => {
  let conflicting;
  const f = await fixture(t, { hooks: { beforeCreate: async (_index, output) => { conflicting = output; await fs.writeFile(output, 'external file won the race', { flag: 'wx' }); } } });
  const plan = await f.prepare(['原%20图.png']); await assert.rejects(f.store.commit(plan.id), { code: 'EEXIST' });
  assert.equal(await fs.readFile(conflicting, 'utf8'), 'external file won the race'); assert.deepEqual(await fs.readFile(f.picture), png); assert.deepEqual(await fs.readFile(f.doc), f.raw);
});

test('rollback preserves a new copy modified by another program', async t => {
  const f = await fixture(t, { hooks: { afterCopy: async (_index, output) => { await fs.writeFile(output, Buffer.concat([png, Buffer.from('external')])); throw new Error('failure'); } } });
  const plan = await f.prepare(['原%20图.png']); await assert.rejects(f.store.commit(plan.id), /外部修改.*已保留/);
  assert.equal((await fs.readdir(f.target)).length, 1); assert.deepEqual(await fs.readFile(f.picture), png);
});

test('external document or image changes invalidate the preview and leave originals intact', async t => {
  const f = await fixture(t);
  let plan = await f.prepare(['原%20图.png']); await fs.writeFile(f.doc, 'External document');
  await assert.rejects(f.store.commit(plan.id), /其他程序修改/); assert.equal(await fs.readFile(f.doc, 'utf8'), 'External document');
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  await fs.writeFile(f.doc, f.raw); plan = await f.prepare(['原%20图.png']); await fs.writeFile(f.picture, Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(f.store.commit(plan.id), /预览后已变化/); await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('source links, target links, traversal, protected paths and unauthorized documents are rejected', async t => {
  const f = await fixture(t); const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meki-attachments-outside-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, 'secret.png'), png);
  await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(f.root, '.git')); await fs.writeFile(path.join(f.root, '.git', 'secret.png'), png);
  for (const source of ['linked/secret.png', path.join(outside, 'secret.png'), '../outside.png', '.git/secret.png', 'javascript:evil', '//server/image.png']) await assert.rejects(f.prepare([source]));
  await assert.rejects(f.store.prepare({ documentPath: path.join(f.root, 'other.md'), revision: digest(f.raw), sources: [] }), /authorized/);
  await fs.symlink(outside, f.target, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.prepare(['原%20图.png']), /链接/);
  assert.deepEqual(await fs.readdir(outside), ['secret.png']);
});

test('rechecks target and boundary after preview, including a directory replaced by a junction', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'elsewhere'));
  const plan = await f.prepare(['原%20图.png']); await fs.symlink(path.join(f.root, 'elsewhere'), f.target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.commit(plan.id), /链接/); assert.deepEqual(await fs.readdir(path.join(f.root, 'elsewhere')), []);
  await fs.unlink(f.target);
  const next = await f.prepare(['原%20图.png']); f.store.boundary = async () => path.join(f.root, 'elsewhere');
  await assert.rejects(f.store.commit(next.id), /工作区已切换/);
});

test('validates formats, input, expiration, image count and byte limits before writing', async t => {
  const f = await fixture(t, { limits: { image: png.length, images: 1, bytes: png.length } });
  await fs.writeFile(path.join(f.root, 'fake.png'), 'not a PNG'); await fs.writeFile(path.join(f.root, 'large.png'), Buffer.concat([png, Buffer.from('large')])); await fs.writeFile(path.join(f.root, 'second.png'), png);
  for (const sources of [['fake.png'], ['large.png'], ['原%20图.png', 'second.png'], ['data:text/html;base64,SGVsbG8='], ['data:image/png;base64,SGVsbG8='], ['data:image/png;base64,@@@']]) await assert.rejects(f.prepare(sources));
  await assert.rejects(f.store.prepare({ documentPath: f.doc, revision: null, sources: [] }));
  await assert.rejects(f.prepare(Array(257).fill('原%20图.png')));
  const plan = await f.prepare(['原%20图.png']); f.store.plan.expires = 0; await assert.rejects(f.store.commit(plan.id), /失效/); await f.store.finish(plan.id, false);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('batch byte limit is independent of image count, and remote URLs never trigger filesystem work', async t => {
  const f = await fixture(t, { limits: { bytes: png.length + 1 } }); await fs.writeFile(path.join(f.root, 'second.png'), png);
  await assert.rejects(f.prepare(['原%20图.png', 'second.png']), /80 MiB/);
  const plan = await f.prepare(['https://example.invalid/image.png']); assert.equal(plan.remote, 1); assert.equal(plan.count, 0);
  assert.deepEqual(await f.store.commit(plan.id), []); await f.store.finish(plan.id, true); await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('renderer crash abandons capabilities without deleting copies referenced by recoverable dirty content', async t => {
  const { FileStore } = require('../electron/file-store.cjs'); const { LifecycleStore } = require('../electron/lifecycle-store.cjs');
  const f = await fixture(t); const files = new FileStore(path.join(f.root, 'profile')); await files.init();
  const lifecycle = new LifecycleStore(files); await lifecycle.init();
  const doc = await files.readDocument(f.doc); const plan = await f.prepare(['原%20图.png']); const mapping = await f.store.commit(plan.id);
  await lifecycle.saveSession({ activeId: 'attachment-tab', documents: [{ ...doc, id: 'attachment-tab', content: `![copied](${mapping[0].relativePath})`, dirty: true, mode: 'source', paused: 'attachments' }] });
  f.store.abandon(); await assert.rejects(f.store.finish(plan.id, false), /失效/);
  const reopened = new LifecycleStore(files); await reopened.init(); const session = await reopened.restore(false);
  assert.equal(session.documents[0].paused, 'attachments'); assert.ok(session.documents[0].content.includes(mapping[0].relativePath));
  assert.deepEqual(await fs.readFile(path.join(f.root, decodeURIComponent(mapping[0].relativePath))), png); assert.deepEqual(await fs.readFile(f.doc), f.raw);
  const next = await f.prepare(['原%20图.png']); await f.store.finish(next.id, false); assert.equal((await fs.readdir(f.target)).length, 1);
});

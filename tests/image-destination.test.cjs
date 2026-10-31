const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeDestinationSettings, resolveImageDestination, ensureImageDestination, rollbackImageDirectories } = require('../electron/image-destination.cjs');

async function fixture(t) {
  const parent = await fs.realpath(__dirname), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'destination-test-')));
  t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('destination-test-')); await fs.rm(actual, { recursive: true, force: true }); });
  const workspace = path.join(root, 'workspace'), folder = path.join(workspace, 'notes'); await fs.mkdir(folder, { recursive: true });
  const documentPath = path.join(folder, '笔记.md'); await fs.writeFile(documentPath, '# Keep document');
  return { root, workspace, folder, documentPath };
}
test('directory settings have a compatible default and reject traversal, absolute paths, devices and unsupported templates', () => {
  assert.deepEqual(normalizeDestinationSettings(), { base: 'document', directory: '${filename}.assets' });
  assert.deepEqual(normalizeDestinationSettings({ base: 'workspace', directory: 'images\\${filename}' }), { base: 'workspace', directory: 'images/${filename}' });
  for (const directory of ['', '../images', 'a/../images', '/tmp/images', '\\\\server\\images', 'C:\\images', 'images//x', 'a/./b', 'NUL', 'COM1.foo', '.git', 'a/node_modules', 'images/${path}', 'images/${filename}/../x', 'tail. ', 'a/b/c/d/e/f/g/h/i']) assert.throws(() => normalizeDestinationSettings({ directory }), undefined, directory);
  assert.throws(() => normalizeDestinationSettings({ base: 'absolute', directory: 'images' }));
});
test('preview is read-only, expands the document name and creates only the selected relative directory', async t => {
  const f = await fixture(t), plan = await resolveImageDestination({ documentPath: f.documentPath });
  assert.equal(plan.target, path.join(f.folder, '笔记.assets'));
  await assert.rejects(fs.stat(plan.target), { code: 'ENOENT' });
  const ready = await ensureImageDestination(plan); assert.equal(ready.created.length, 1);
  assert.equal(await fs.readFile(f.documentPath, 'utf8'), '# Keep document');
  assert.equal(await rollbackImageDirectories(ready.created, plan.root), false);
  await assert.rejects(fs.stat(plan.target), { code: 'ENOENT' });
  assert.equal(await rollbackImageDirectories(ready.created, plan.root), false);
});
test('workspace-relative nested directories remain within the authorized workspace', async t => {
  const f = await fixture(t), plan = await resolveImageDestination({ documentPath: f.documentPath, workspaceRoot: f.workspace, base: 'workspace', directory: 'media/${filename}/pictures' });
  assert.equal(plan.relativePath, '../media/笔记/pictures');
  const ready = await ensureImageDestination(plan); assert.equal(ready.created.length, 3);
  assert.ok((await fs.stat(plan.target)).isDirectory());
  assert.equal(await rollbackImageDirectories(ready.created, plan.root), false);
});
test('workspace mode requires the matching workspace and cannot expand outside a narrower authorization boundary', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveImageDestination({ documentPath: f.documentPath, base: 'workspace' }), /工作区/);
  await assert.rejects(resolveImageDestination({ documentPath: f.documentPath, workspaceRoot: f.root, boundaryRoot: f.folder, base: 'workspace' }), /工作区/);
  const outside = path.join(f.root, 'other'); await fs.mkdir(outside);
  await assert.rejects(resolveImageDestination({ documentPath: f.documentPath, workspaceRoot: outside, base: 'workspace' }), /工作区/);
});
test('existing directories are reused, and cleanup only removes this operation’s empty directories', async t => {
  const f = await fixture(t), existing = path.join(f.folder, 'images'); await fs.mkdir(existing);
  const plan = await resolveImageDestination({ documentPath: f.documentPath, directory: 'images/new' }), ready = await ensureImageDestination(plan);
  assert.equal(ready.created.length, 1); assert.equal(ready.created[0].path, path.join(existing, 'new'));
  await fs.writeFile(path.join(ready.target, 'external.txt'), 'keep');
  assert.equal(await rollbackImageDirectories(ready.created, plan.root), true);
  assert.equal(await fs.readFile(path.join(ready.target, 'external.txt'), 'utf8'), 'keep');
  const sameDirectory = await resolveImageDestination({ documentPath: f.documentPath, directory: '.' });
  assert.deepEqual((await ensureImageDestination(sameDirectory)).created, []);
});
test('symlink or junction components are rejected in previews and when replaced after preview', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const linked = path.join(f.folder, 'linked'); await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveImageDestination({ documentPath: f.documentPath, directory: 'linked/sub' }), /链接/);
  const plan = await resolveImageDestination({ documentPath: f.documentPath, directory: 'fresh/sub' });
  await fs.symlink(outside, path.join(f.folder, 'fresh'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureImageDestination(plan), /链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('cleanup does not remove a replacement directory with the same name', async t => {
  const f = await fixture(t), ready = await ensureImageDestination(await resolveImageDestination({ documentPath: f.documentPath }));
  await fs.rename(ready.target, ready.target + '-original'); await fs.mkdir(ready.target);
  assert.equal(await rollbackImageDirectories(ready.created, ready.root), true);
  assert.ok((await fs.stat(ready.target)).isDirectory()); assert.ok((await fs.stat(ready.target + '-original')).isDirectory());
});
test('replacing the authorization root with another ordinary directory invalidates the preview', async t => {
  const f = await fixture(t), plan = await resolveImageDestination({ documentPath: f.documentPath });
  assert.equal(path.dirname(f.folder), f.workspace);
  await fs.rename(f.folder, f.folder + '-original'); await fs.mkdir(f.folder);
  await fs.copyFile(path.join(f.folder + '-original', path.basename(f.documentPath)), f.documentPath);
  await assert.rejects(ensureImageDestination(plan), /已变化/);
  await assert.rejects(fs.stat(plan.target), { code: 'ENOENT' });
});
test('concurrent directory creation reuses the winner without deleting existing directories', async t => {
  const f = await fixture(t), plan = await resolveImageDestination({ documentPath: f.documentPath, directory: 'images/nested' });
  const created = await Promise.all([ensureImageDestination(plan), ensureImageDestination(plan)]);
  assert.equal(created.reduce((total, item) => total + item.created.length, 0), 2);
  await fs.writeFile(path.join(plan.target, 'keep.txt'), 'keep');
  for (const item of created) await rollbackImageDirectories(item.created, plan.root);
  assert.equal(await fs.readFile(path.join(plan.target, 'keep.txt'), 'utf8'), 'keep');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('packaging includes renderer bytes when dist is a directory junction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-package-staging-'));
  try {
    const output = path.join(root, 'build-output');
    await fs.mkdir(path.join(output, 'assets'), { recursive: true });
    await fs.writeFile(path.join(output, 'index.html'), '<script src="assets/editor.js"></script>');
    await fs.writeFile(path.join(output, 'assets', 'editor.js'), 'window.editorReady = true;');
    await fs.symlink(output, path.join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'meki', version: '0.12.2', main: 'electron/bootstrap.cjs', license: 'MIT' }));
    for (const name of ['electron', 'assets']) await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, 'electron', 'bootstrap.cjs'), '// isolated fixture');
    for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) await fs.writeFile(path.join(root, name), 'fixture');

    const { stageApplication } = await import('../scripts/stage-application.mjs');
    const { stage } = await stageApplication(root);
    assert.equal((await fs.lstat(path.join(stage, 'dist'))).isSymbolicLink(), false);
    const asar = await import('@electron/asar');
    const archive = path.join(root, 'app.asar');
    await asar.createPackage(stage, archive);
    // Removing the original build output proves the archive is self-contained.
    await fs.rm(output, { recursive: true, force: true });
    assert.equal(asar.extractFile(archive, path.join('dist', 'index.html')).toString(), '<script src="assets/editor.js"></script>');
    assert.equal(asar.extractFile(archive, path.join('dist', 'assets', 'editor.js')).toString(), 'window.editorReady = true;');
    assert.equal(asar.extractFile(archive, 'LICENSE').toString(), 'fixture');
    assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).license, 'MIT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

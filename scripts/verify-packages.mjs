import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url), plist = require('plist');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = data => createHash('sha256').update(data).digest('hex');
const results = [];
const sourcePackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}
const packedFiles = [...await sourceFiles('electron'), ...await sourceFiles('dist'), ...await sourceFiles('assets'), 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'];
for (const target of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
  const directory = path.join(root, 'release', 'packages', `${sourcePackage.productName}-${target}`);
  const mac = target.startsWith('darwin');
  const contents = path.join(directory, `${sourcePackage.productName}.app`, 'Contents');
  const archive = mac ? path.join(contents, 'Resources', 'app.asar') : path.join(directory, 'resources', 'app.asar');
  for (const name of packedFiles) assert.equal(digest(extractFile(archive, name)), digest(await fs.readFile(path.join(root, name))), `Packaged file differs: ${target}/${name}`);
  const packedPackage = JSON.parse(extractFile(archive, 'package.json').toString());
  assert.equal(packedPackage.version, sourcePackage.version);
  assert.equal(packedPackage.main, sourcePackage.main);
  let architecture = 'x64', links = 0;
  if (mac) {
    const info = plist.parse(await fs.readFile(path.join(contents, 'Info.plist'), 'utf8'));
    assert.equal(info.CFBundleIdentifier, 'io.meki.editor');
    assert.deepEqual(Object.keys(info.ElectronAsarIntegrity), ['Resources/app.asar']);
    assert.equal(digest(await fs.readFile(path.join(contents, 'Resources', info.CFBundleIconFile))), digest(await fs.readFile(path.join(root, 'assets', 'icon.icns'))));
    const executable = await fs.readFile(path.join(contents, 'MacOS', sourcePackage.productName));
    assert.equal(executable.readUInt32LE(0), 0xfeedfacf);
    architecture = executable.readUInt32LE(4) === 0x100000c ? 'arm64' : 'x64';
    assert.ok(target.endsWith(architecture));
    async function walk(dir) {
      for (const name of await fs.readdir(dir)) {
        const entry = path.join(dir, name), stat = await fs.lstat(entry);
        if (stat.isSymbolicLink()) { const link = await fs.readlink(entry); assert.ok(!path.isAbsolute(link)); links++; }
        else if (stat.isDirectory()) await walk(entry);
      }
    }
    await walk(contents);
    assert.ok(links >= 5);
  } else {
    const executable = await fs.readFile(path.join(directory, 'Meki.exe'));
    assert.equal(executable.subarray(0, 2).toString(), 'MZ');
  }
  results.push({ target, sourceCommit, sourceVersion: sourcePackage.version, asarSha256: digest(await fs.readFile(archive)), archiveMatchesSource: true, architecture, relativeSymlinks: links });
}
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
await fs.writeFile(path.join(root, 'test-results', 'packages.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, Platform, Arch } from 'electron-builder';
import config from '../electron-builder.cjs';
import { root, stageApplication } from './stage-application.mjs';
import { createUpdateAssets } from './update-assets.mjs';
import policy from '../electron/update-policy.cjs';

if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Build installers on native Windows or macOS.');
if (!process.env.MOYE_UPDATE_SIGN_KEY) throw new Error('Set MOYE_UPDATE_SIGN_KEY before explicitly building a release.');
const platform = process.platform === 'win32' ? 'windows' : 'macos';
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const { stage, pkg, release } = await stageApplication();
const output = path.join(release, 'installers');
const artifacts = await build({
  projectDir: root,
  targets: process.platform === 'win32' ? Platform.WINDOWS.createTarget(['nsis'], Arch.x64) : Platform.MAC.createTarget(['dmg'], Arch.universal),
  publish: 'never',
  config: { ...config, electronVersion: pkg.devDependencies.electron,
    // Reuse the verified native runtime installed by Electron's installer.
    electronDist: process.platform === 'win32' ? path.dirname(createRequire(import.meta.url)('electron')) : undefined,
    directories: { ...config.directories, app: stage, output } },
});
const installer = artifacts.find(file => file.endsWith(process.platform === 'win32' ? '.exe' : '.dmg'));
if (!installer) throw new Error('Installer artifact missing.');
const asar = path.join(output, process.platform === 'win32' ? 'win-unpacked/resources/app.asar' : `mac-universal/${pkg.productName}.app/Contents/Resources/app.asar`);
const sha256 = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
const manifest = { version: pkg.version, sourceCommit, platform, arch: process.platform === 'win32' ? 'x64' : 'universal',
  installer: path.basename(installer), sha256: await sha256(installer), asarSha256: await sha256(asar),
  compatibilityInstaller: policy.names(pkg.version, process.platform).installer,
  signing: process.platform === 'win32' ? 'unsigned' : 'ad-hoc, not notarized',
  builtOn: `${process.platform}-${process.arch}`, };
manifest.updateAssets = await createUpdateAssets({ directory: output, asar, installer, version: pkg.version, platform: process.platform,
  electron: pkg.devDependencies.electron, signingKey: process.env.MOYE_UPDATE_SIGN_KEY });
await fs.writeFile(path.join(output, `${platform}-build.json`), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));

import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stageApplication } from './stage-application.mjs';
import identity from '../electron/app-identity.cjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2] || process.platform;
const archs = (process.argv[3] || process.arch).split(',');
if (!['win32', 'darwin'].includes(platform) || archs.some(a => !['x64', 'arm64'].includes(a))) throw new Error('Supported: win32/darwin x64/arm64.');
const { pkg, release, stage } = await stageApplication();
const out = path.join(release, 'packages');
await fs.mkdir(out, { recursive: true });
// Only these generated, bounded output paths may be replaced on a repeated build.
for (const arch of archs) {
  const target = path.resolve(out, `${pkg.productName}-${platform}-${arch}`);
  if (path.dirname(target) !== out) throw new Error('Invalid packaging output path');
  await fs.rm(target, { recursive: true, force: true });
}
const outputs = await packager({ dir: stage, out, name: pkg.productName, appVersion: pkg.version, platform, arch: archs,
  executableName: platform === 'win32' ? identity.WINDOWS_EXECUTABLE : pkg.productName,
  electronVersion: pkg.devDependencies.electron, asar: true, prune: false,
  appBundleId: identity.APP_ID, appCategoryType: 'public.app-category.productivity', darwinDarkModeSupport: true,
  icon: path.join(root, 'assets', platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
  download: { checksums: require('electron/checksums.json') },
  extendInfo: { CFBundleDocumentTypes: [{ CFBundleTypeName: 'Markdown document', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', CFBundleTypeExtensions: ['md', 'markdown', 'mdown', 'txt'] }] },
  win32metadata: { CompanyName: pkg.author, FileDescription: `${pkg.productName} Markdown Editor`, ProductName: pkg.productName },
});
if (outputs.length !== archs.length) throw new Error('Not all requested architectures were packaged.');
// Packager 20.3 uses path.posix.relative on Windows paths for this plist field.
// Repair the generated resource key while the macOS bundle is still unsigned.
if (platform === 'darwin' && process.platform === 'win32') {
  const plist = require('plist');
  for (const output of outputs) {
    const filename = path.join(output, `${pkg.productName}.app`, 'Contents', 'Info.plist');
    const info = plist.parse(await fs.readFile(filename, 'utf8'));
    const values = Object.values(info.ElectronAsarIntegrity || {});
    if (values.length !== 1) throw new Error('Unexpected macOS ASAR integrity structure.');
    info.ElectronAsarIntegrity = { 'Resources/app.asar': values[0] };
    await fs.writeFile(filename, plist.build(info));
  }
}
console.log(JSON.stringify({ platform, outputs }, null, 2));

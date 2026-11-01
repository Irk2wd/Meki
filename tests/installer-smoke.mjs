import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { root } from '../scripts/stage-application.mjs';
import { verifyUpdateAssets } from '../scripts/update-assets.mjs';

// Installation mutates OS registration. Use only disposable GitHub-hosted runners,
// never the developer's real profile or an existing Meki installation.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer lifecycle tests require a disposable CI runner.');
assert.ok(['win32', 'darwin'].includes(process.platform));
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const exec = promisify(execFile);
const runFile = async (file, args = [], options = {}) => (await exec(file, args, { cwd: root, windowsHide: true, timeout: 300000, maxBuffer: 10 * 1024 * 1024, ...options })).stdout.trim();
const powershell = async script => runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')]);
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists = async file => !!await fs.stat(file).catch(() => null);
const platform = process.platform === 'win32' ? 'windows' : 'macos';
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const uiCommands = pkg.scripts['test:ui'].split(' && ');
for (const command of uiCommands) assert.match(command, /^node tests\/[a-z][a-z0-9-]*-smoke\.mjs$/);
const artifactFolder = path.join(root, 'release', 'installers');
const manifest = JSON.parse(await fs.readFile(path.join(artifactFolder, `${platform}-build.json`), 'utf8'));
const installer = path.join(artifactFolder, manifest.installer);
assert.equal(path.dirname(installer), artifactFolder);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.sourceCommit, await runFile('git', ['rev-parse', 'HEAD']));
assert.equal(await hash(installer), manifest.sha256);
await verifyUpdateAssets(manifest, artifactFolder);
const resultRoot = path.join(root, 'test-results');
await fs.mkdir(resultRoot, { recursive: true });
const run = await fs.mkdtemp(path.join(resultRoot, 'installer-'));
const report = { ...manifest, testedOn: `${process.platform}-${process.arch}`, checks: [], ui: [], errors: [] };
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const profile = path.join(process.platform === 'win32' ? process.env.APPDATA : path.join(process.env.HOME, 'Library', 'Application Support'), 'Meki');
assert.equal(await exists(profile), false, 'Refuse to test against an existing user profile.');
await fs.mkdir(profile, { recursive: true });
const marker = path.join(profile, 'installer-preservation-check.txt');
const document = path.join(run, '我的文稿.md');
const preserved = '\uFEFF# Installer preservation\r\n\r\n$x^2$\r\n';
await fs.writeFile(marker, preserved);
await fs.writeFile(document, preserved);
const preservedFiles = async () => { assert.equal(await fs.readFile(marker, 'utf8'), preserved); assert.equal(await fs.readFile(document, 'utf8'), preserved); };
let executable, application, mount;
const installDirectory = path.join(run, 'Applications', pkg.productName);
process.env.MEKI_INSTALLER_PATH = installer;
process.env.MEKI_INSTALL_DIRECTORY = installDirectory;
const registry = String.raw`
$found = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Meki' })
$installed = @($found | Select-Object DisplayVersion,UninstallString,@{Name='InstallLocation';Expression={(Get-ItemProperty -LiteralPath ("HKCU:\Software\" + $_.PSChildName)).InstallLocation}})
$open = Get-Item 'HKCU:\Software\Classes\Meki.Markdown\shell\open\command' -ErrorAction SilentlyContinue
$md = Get-Item 'HKCU:\Software\Classes\.md\OpenWithProgids' -ErrorAction SilentlyContinue
$links = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) | ForEach-Object {
  $link = Join-Path $_ 'Meki.lnk'
  if (Test-Path -LiteralPath $link) { (New-Object -ComObject WScript.Shell).CreateShortcut($link).TargetPath }
}
@{ installed = $installed; command = $(if ($open) { $open.GetValue('') } else { $null }); openWith = $(if ($md) { $md.GetValueNames() -contains 'Meki.Markdown' } else { $false }); shortcuts = @($links) } | ConvertTo-Json -Depth 4 -Compress
`;
const defaultAssociation = () => powershell(String.raw`
$values = @()
foreach ($extension in @('.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.txt')) {
  foreach ($key in @("HKCU:\Software\Classes\$extension", "HKLM:\Software\Classes\$extension", "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$extension\UserChoice")) {
    $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
    $values += $(if ($item) { @($item.GetValue(''), $item.GetValue('ProgId')) } else { @($null, $null) })
  }
}
ConvertTo-Json -InputObject $values -Compress`);
const installWindows = () => powershell(`
$arguments = '/S /currentuser /D=' + $env:MEKI_INSTALL_DIRECTORY
$installerProcess = Start-Process -FilePath $env:MEKI_INSTALLER_PATH -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if ($installerProcess.ExitCode -ne 0) { throw "Installer exit: $($installerProcess.ExitCode)" }`);
async function verifyPayload() {
  const archive = process.platform === 'win32' ? path.join(application, 'resources', 'app.asar') : path.join(application, 'Contents', 'Resources', 'app.asar');
  assert.equal(await hash(archive), manifest.asarSha256);
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, pkg.version);
  assert.ok(await exists(executable));
  if (process.platform === 'darwin') {
    await runFile('codesign', ['--verify', '--deep', '--strict', application]);
    const architectures = (await runFile('lipo', ['-archs', executable])).split(/\s+/).sort();
    assert.deepEqual(architectures, ['arm64', 'x86_64']);
    assert.equal(await runFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(application, 'Contents', 'Info.plist')]), 'io.meki.editor');
    assert.equal(await runFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(application, 'Contents', 'Info.plist')]), pkg.version);
  }
}
let defaults;
try {
  const unitFiles = (await fs.readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.cjs')).map(name => path.join('tests', name));
  const unitLog = await runFile(process.execPath, ['--test', '--test-reporter=tap', ...unitFiles]);
  await fs.writeFile(path.join(run, 'unit-tests.log'), unitLog);
  report.unitTests = Number(unitLog.match(/^# pass (\d+)$/m)?.[1]);
  assert.ok(report.unitTests >= 257);
  assert.match(unitLog, /^# fail 0$/m);
  pass(`${report.unitTests} unit tests`);
  if (process.platform === 'win32') {
    defaults = await defaultAssociation();
    const before = JSON.parse(await powershell(registry));
    assert.equal(before.installed.length, 0, 'Refuse to replace an existing installation.');
    assert.equal(before.command, null);
    assert.equal(before.shortcuts.length, 0);
    await installWindows();
    application = installDirectory;
    executable = path.join(application, 'Meki.exe');
    await verifyPayload();
    const state = JSON.parse(await powershell(registry));
    assert.equal(state.installed.length, 1);
    assert.equal(state.installed[0].DisplayVersion, pkg.version);
    assert.equal(path.resolve(state.installed[0].InstallLocation), application);
    assert.equal(state.installed[0].UninstallString, `"${path.join(application, 'Uninstall Meki.exe')}" /currentuser`);
    assert.equal(state.command, `"${executable}" --open "%1"`);
    assert.equal(state.openWith, true);
    assert.deepEqual(state.shortcuts, [executable, executable]);
    assert.equal(await defaultAssociation(), defaults);
    pass('EXE installs to a chosen directory, registers uninstall/shortcuts/Open with, and preserves default associations');
    await installWindows();
    await verifyPayload();
    await preservedFiles();
    pass('reinstall replaces the application while preserving documents and user settings');
  } else {
    await runFile('hdiutil', ['verify', installer]);
    mount = path.join(run, 'mounted');
    await fs.mkdir(mount);
    await runFile('hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount]);
    assert.equal(await fs.readlink(path.join(mount, 'Applications')), '/Applications');
    assert.ok(await exists(path.join(mount, '.DS_Store')));
    application = path.join(run, 'Applications', `${pkg.productName}.app`);
    executable = path.join(application, 'Contents', 'MacOS', pkg.productName);
    await fs.mkdir(path.dirname(application), { recursive: true });
    await runFile('ditto', [path.join(mount, `${pkg.productName}.app`), application]);
    await verifyPayload();
    // Copying a new version over the previous app is the macOS update workflow.
    await runFile('ditto', [path.join(mount, `${pkg.productName}.app`), application]);
    await verifyPayload();
    await runFile('hdiutil', ['detach', mount]); mount = undefined;
    await preservedFiles();
    pass('DMG verifies and mounts with Applications shortcut; copied universal app passes signature/version/architecture checks');
    pass('replacing the Mac application preserves documents and user settings');
  }
  const previous = new Set(await fs.readdir(resultRoot));
  const failedSuites = [];
  for (const command of uiCommands) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [command.slice(5)], { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, MEKI_EXECUTABLE: executable, MEKI_REQUIRE_PANDOC: '1' } });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
    }).catch(error => {
      failedSuites.push(error.message);
      console.error(`FAIL ${error.message}; continuing to collect the remaining suite results`);
    });
  }
  for (const folder of await fs.readdir(resultRoot)) {
    if (previous.has(folder)) continue;
    const file = path.join(resultRoot, folder, 'results.json');
    if (!await exists(file)) continue;
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(result.errors, []);
    assert.equal(result.skipped?.length || 0, 0);
    report.ui.push({ suite: folder, results: result.results });
  }
  assert.equal(report.ui.length, uiCommands.length);
  assert.deepEqual(failedSuites, [], failedSuites.join('\n'));
  report.uiChecks = report.ui.reduce((sum, item) => sum + item.results.length, 0);
  assert.ok(report.uiChecks >= 237);
  pass(`${report.uiChecks} desktop checks against the installed application, including real Pandoc conversion`);
  if (process.platform === 'win32') {
    await powershell(`
$uninstaller = Join-Path $env:MEKI_INSTALL_DIRECTORY 'Uninstall Meki.exe'
$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -WindowStyle Hidden -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exit: $($uninstallProcess.ExitCode)" }`);
    for (let attempt = 0; await exists(executable) && attempt < 120; attempt++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await exists(executable), false);
    const state = JSON.parse(await powershell(registry));
    assert.equal(state.installed.length, 0);
    assert.equal(state.command, null);
    assert.equal(state.openWith, false);
    assert.equal(state.shortcuts.length, 0);
    assert.equal(await defaultAssociation(), defaults);
  } else {
    const realRun = await fs.realpath(run), target = await fs.realpath(application);
    assert.ok(target.startsWith(realRun + path.sep));
    assert.equal(path.basename(target), `${pkg.productName}.app`);
    await fs.rm(target, { recursive: true });
    assert.equal(await exists(executable), false);
  }
  await preservedFiles();
  pass('uninstall removes the app and its integration but retains documents and user settings');
  report.success = true;
} catch (error) {
  report.errors.push(error.stack || String(error));
  throw error;
} finally {
  if (mount) await runFile('hdiutil', ['detach', mount]).catch(() => {});
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Installer evidence: ${run}`);
}

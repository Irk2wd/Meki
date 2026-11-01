// Optional application tool; installed only in the CI runner's temporary directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const version = '3.12.1', execute = promisify(execFile);
const releases = {
  'win32-x64': ['windows-x86_64.zip', '6ef431cb20b2c24a0371fc19200dc49d452be54b1b5c9239f3462841ef53e587'],
  'darwin-arm64': ['arm64-macOS.zip', 'c2146cf33a583f3ac93eccddf1bb662371d5cfcce1aad1c87ad860cca1435d46'],
  'darwin-x64': ['x86_64-macOS.zip', '81ed3e2cfecf096df15d407152f89a684fd65221082b919963f738e977fad3bc'],
};
const release = releases[`${process.platform}-${process.arch}`];
if (!release) throw new Error(`No verified Pandoc asset for ${process.platform}-${process.arch}`);
if (!process.env.GITHUB_ENV) throw new Error('Run this installer in GitHub Actions; select a local Pandoc through Meki settings for normal use.');
const folder = await fs.mkdtemp(path.join(await fs.realpath(process.env.RUNNER_TEMP || os.tmpdir()), 'meki-pandoc-ci-'));
const archive = path.join(folder, 'pandoc.zip'), destination = path.join(folder, 'portable');
const url = `https://github.com/jgm/pandoc/releases/download/${version}/pandoc-${version}-${release[0]}`;
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const output = await fs.open(archive, 'w'), digest = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error('Pandoc archive exceeds 128 MiB');
        digest.update(chunk); await output.writeFile(chunk);
      }
    } finally { await output.close(); }
    const actual = digest.digest('hex'); if (actual !== release[1]) throw new Error(`SHA-256 mismatch for ${release[0]}: ${actual}`);
    break;
  } catch (error) { if (attempt >= 2) throw error; console.warn(`Pandoc download attempt ${attempt + 1} failed: ${error.message}`); }
}
await fs.mkdir(destination);
if (process.platform === 'win32') {
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MEKI_CI_ARCHIVE -DestinationPath $env:MEKI_CI_DESTINATION'], { windowsHide: true, timeout: 120_000, env: { ...process.env, MEKI_CI_ARCHIVE: archive, MEKI_CI_DESTINATION: destination } });
} else await execute('/usr/bin/ditto', ['-x', '-k', archive, destination], { timeout: 120_000 });
async function findExecutable(root) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, item.name);
    if (item.isFile() && item.name === (process.platform === 'win32' ? 'pandoc.exe' : 'pandoc')) return candidate;
    if (item.isDirectory()) { const result = await findExecutable(candidate); if (result) return result; }
  }
}
const executable = await findExecutable(destination); if (!executable) throw new Error('Verified archive contains no Pandoc executable');
if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
const { stdout } = await execute(executable, ['--version'], { windowsHide: true, timeout: 15_000 });
if (!stdout.startsWith(`pandoc ${version}\n`) && !stdout.startsWith(`pandoc ${version}\r\n`)) throw new Error('Unexpected Pandoc executable version');
await fs.appendFile(process.env.GITHUB_ENV, `MEKI_PANDOC_PATH=${executable}\nMEKI_REQUIRE_PANDOC=1\n`);
await fs.unlink(archive);
console.log(`Verified Pandoc ${version}: ${executable}`);

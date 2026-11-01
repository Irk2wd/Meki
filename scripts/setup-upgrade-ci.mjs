import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const previousWindows = Object.freeze({
  version: '1.0.0',
  name: 'Meki-1.0.0-Setup-x64.exe',
  size: 118388722,
  sha256: '18dc0d126106cf1e71112efdfcfd8df7fa3fb831f8efe2a3150e0860eead4207',
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.GITHUB_ENV);
  const folder = await fsp.mkdtemp(path.join(await fsp.realpath(process.env.RUNNER_TEMP || os.tmpdir()), 'meki-upgrade-ci-'));
  const file = path.join(folder, previousWindows.name);
  const response = await fetch(`https://github.com/Irk2wd/Meki/releases/download/v${previousWindows.version}/${previousWindows.name}`, { signal: AbortSignal.timeout(180000) });
  assert.ok(response.ok && response.body, `Installer download failed: ${response.status}`);
  const hash = crypto.createHash('sha256'); let size = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > previousWindows.size) return done(new Error('Previous installer exceeds its pinned size'));
    hash.update(chunk); done(null, chunk);
  } }), fs.createWriteStream(file, { flags: 'wx' }));
  assert.equal(size, previousWindows.size);
  assert.equal(hash.digest('hex'), previousWindows.sha256);
  await fsp.appendFile(process.env.GITHUB_ENV, `MEKI_UPGRADE_INSTALLER=${file}\n`);
  console.log(`Verified previous Meki ${previousWindows.version} installer for upgrade regression.`);
}

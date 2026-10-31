import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import policy from '../electron/update-policy.cjs';
import files from '../electron/update-runtime.cjs';
import publicKey from '../electron/update-key.cjs';
import identity from '../electron/app-identity.cjs';

export async function createUpdateAssets({ directory, asar, installer, version, platform, electron, signingKey, verificationKey = publicKey }) {
  if (!signingKey) throw new Error('MOYE_UPDATE_SIGN_KEY is required for release update assets.');
  const key = crypto.createPrivateKey(signingKey);
  if (crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== verificationKey) throw new Error('Release signing key does not match the application verification key.');
  const names = policy.names(version, platform), payload = path.join(directory, names.payload);
  const compatibilityInstaller = path.join(directory, names.installer);
  if (path.resolve(installer) !== path.resolve(compatibilityInstaller)) {
    if (path.basename(installer) !== identity.installerName(version, platform)) throw new Error('Unexpected installer name.');
    // Both names contain exactly the same tested installer. Existing clients
    // require the original name in their signed update protocol.
    fs.copyFileSync(installer, compatibilityInstaller, fs.constants.COPYFILE_EXCL);
  }
  await pipeline(fs.createReadStream(asar), zlib.createGzip({ level: 9 }), fs.createWriteStream(payload, { flags: 'wx' }));
  const manifest = { appId: identity.APP_ID, version, bootstrap: policy.BOOTSTRAP_VERSION, electron, platform, arch: platform === 'win32' ? 'x64' : 'universal',
    asarSha256: files.hashFile(asar), asarSize: fs.statSync(asar).size,
    payload: { name: names.payload, size: fs.statSync(payload).size, sha256: files.hashFile(payload) },
    installer: { name: names.installer, size: fs.statSync(compatibilityInstaller).size, sha256: files.hashFile(compatibilityInstaller) } };
  const body = Buffer.from(JSON.stringify(manifest));
  const envelope = { schema: 1, body: body.toString('base64'), signature: crypto.sign(null, body, key).toString('base64') };
  policy.verifyManifest(envelope, verificationKey, { version, platform });
  const manifestFile = path.join(directory, names.manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(envelope, null, 2) + '\n');
  return [payload, manifestFile].map(file => ({ name: path.basename(file), size: fs.statSync(file).size, sha256: files.hashFile(file) }));
}

export async function verifyUpdateAssets(build, directory, verificationKey = publicKey) {
  if (!['windows', 'macos'].includes(build.platform)) throw new Error('Invalid build platform');
  const platform = build.platform === 'windows' ? 'win32' : 'darwin', names = policy.names(build.version, platform);
  if (![names.installer, identity.installerName(build.version, platform)].includes(build.installer)) throw new Error('Unexpected installer name');
  if (build.installer !== names.installer && build.compatibilityInstaller !== names.installer) throw new Error('Missing compatible installer alias');
  if (build.updateAssets?.length !== 2 || new Set(build.updateAssets.map(entry => entry.name)).size !== 2) throw new Error('Missing signed update assets');
  for (const entry of build.updateAssets) {
    if (![names.manifest, names.payload].includes(entry.name)) throw new Error('Unexpected update asset name');
    const file = path.join(directory, entry.name);
    if (files.regular(file, policy.MAX_PAYLOAD).size !== entry.size || files.hashFile(file) !== entry.sha256) throw new Error('Update asset checksum mismatch');
  }
  const manifest = policy.verifyManifest(JSON.parse(fs.readFileSync(path.join(directory, names.manifest), 'utf8')), verificationKey, { version: build.version, platform });
  if (manifest.asarSha256 !== build.asarSha256 || manifest.installer.sha256 !== build.sha256 || manifest.installer.name !== names.installer) throw new Error('Update payload differs from the tested installer');
  const primary = path.join(directory, build.installer);
  if (files.regular(primary, manifest.installer.size).size !== manifest.installer.size || files.hashFile(primary) !== build.sha256) throw new Error('Primary installer checksum mismatch');
  for (const entry of [manifest.payload, manifest.installer]) {
    const file = path.join(directory, entry.name);
    if (files.regular(file, entry.size).size !== entry.size || files.hashFile(file) !== entry.sha256) throw new Error('Signed update asset checksum mismatch');
  }
  let size = 0; const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(path.join(directory, names.payload)), zlib.createGunzip(), new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length; if (size > manifest.asarSize) return done(new Error('Update payload exceeds expected size'));
    hash.update(chunk); done();
  } }));
  if (size !== manifest.asarSize || hash.digest('hex') !== manifest.asarSha256) throw new Error('Update archive checksum mismatch');
  return manifest;
}

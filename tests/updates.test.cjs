'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { keys, fixture, server } = require('./update-fixture.cjs');
const policy = require('../electron/update-policy.cjs');
const { UpdateRuntime, atomicJson } = require('../electron/update-runtime.cjs');
const { UpdateService } = require('../electron/update-service.cjs');
const { GithubUpdates } = require('../electron/update-network.cjs');

const encryption = { available: () => true, encrypt: value => Buffer.from([...value].reverse().join('')), decrypt: value => [...value.toString()].reverse().join('') };
function setup(t, pair, overrides = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'moye-update-test-'));
  t.after(() => {
    const target = fs.realpathSync(folder), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('moye-update-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return new UpdateRuntime({ userData: folder, baseVersion: '0.11.3', electron: '45.0.0', platform: process.platform, arch: process.arch, key: pair.publicKey, ...overrides });
}
async function connected(t, overrides = {}) {
  const pair = keys(), update = fixture(pair, overrides), runtime = setup(t, pair), remote = await server(update);
  t.after(() => remote.close());
  const service = new UpdateService({ runtime, encryption, network: new GithubUpdates({ testOrigin: remote.origin }), cliToken: async () => 'moye-test-token' });
  await service.credentials({ kind: 'cli' });
  return { pair, update, runtime, remote, service };
}
function store(runtime, update) {
  const files = runtime.paths(update.manifest.asarSha256);
  fs.writeFileSync(files.archive, update.payload); atomicJson(files.manifest, update.envelope);
}

test('release versions are ordered numerically; drafts, prereleases and malformed assets are rejected', () => {
  assert.equal(policy.newer('0.12.0', '0.9.9'), true); assert.equal(policy.newer('1.2.0', '1.2.0'), false); assert.equal(policy.newer('0.9.0', '0.12.0'), false);
  for (const value of ['../1.0.0', '01.2.3', '1.2.3-beta', '9999999999.0.0']) assert.throws(() => policy.version(value));
  const update = fixture(keys());
  assert.throws(() => policy.releaseInfo({ ...update.release, draft: true }));
  assert.throws(() => policy.releaseInfo({ ...update.release, prerelease: true }));
  assert.throws(() => policy.asset({ ...update.release, assets: [...update.release.assets, update.release.assets[0]] }, update.release.assets[0].name));
});

test('signed manifests bind the code, installer, platform and release; substituted signatures fail', () => {
  const pair = keys(), update = fixture(pair);
  assert.deepEqual(policy.verifyManifest(update.envelope, pair.publicKey), update.manifest);
  assert.throws(() => policy.verifyManifest(update.envelope, keys().publicKey));
  const changed = { ...update.envelope, body: Buffer.from(JSON.stringify({ ...update.manifest, version: '0.13.0' })).toString('base64') };
  assert.throws(() => policy.verifyManifest(changed, pair.publicKey));
  assert.throws(() => policy.verifyManifest(update.envelope, pair.publicKey, { platform: process.platform === 'win32' ? 'darwin' : 'win32' }));
  assert.throws(() => policy.verifyManifest(update.envelope, pair.publicKey, { version: '0.13.0' }));
});

test('private release download strips credentials on redirects and stages verified code without activating it', async t => {
  const { service, runtime, remote, update } = await connected(t);
  assert.equal((await service.check()).status, 'available');
  assert.equal((await service.download()).status, 'ready');
  assert.equal(runtime.readState().current, null);
  assert.equal(fs.readFileSync(runtime.paths(update.manifest.asarSha256).archive).equals(update.payload), true);
  assert.ok(remote.requests.some(item => item.path.startsWith('/blob/')));
  assert.ok(remote.requests.filter(item => item.path.startsWith('/blob/')).every(item => item.authorization === undefined));
  assert.equal(JSON.stringify(service.snapshot()).includes('moye-test-token'), false);
  assert.equal(service.prepareApply().kind, 'payload');
  assert.equal(runtime.readState().current, null, 'validation alone must not activate an update');
});

test('untrusted redirects are rejected before following them', async t => {
  const { service, remote } = await connected(t); remote.redirect = 'https://example.invalid/token-leak';
  const state = await service.check(); assert.equal(state.status, 'error'); assert.match(state.message, /下载地址/);
});

test('corrupted compressed code is never activated and partial downloads are removed', async t => {
  const { service, remote, runtime } = await connected(t);
  await service.check(); remote.current.blobs.set(2, Buffer.alloc(remote.current.compressed.length, 1));
  assert.equal((await service.download()).status, 'error');
  assert.equal(runtime.readState().current, null);
  assert.equal(fs.readdirSync(runtime.root).some(file => file.includes('.download')), false);
  assert.throws(() => service.prepareApply());
});

test('a bad manifest signature prevents the code download', async t => {
  const { service, remote } = await connected(t);
  const forged = fixture(keys()); remote.current.blobs.set(1, forged.blobs.get(1));
  remote.current.release.assets[0].digest = `sha256:${policy.digest(forged.blobs.get(1))}`;
  assert.equal((await service.check()).status, 'error');
  assert.equal(remote.requests.some(item => item.path.endsWith('/assets/2')), false);
});

test('download cancellation can be retried and overlapping update operations are rejected', async t => {
  const { service, remote, runtime } = await connected(t); await service.check(); remote.holdDownloads = true;
  const download = service.download();
  await assert.rejects(() => service.check(), /正在进行/);
  await new Promise(resolve => setTimeout(resolve, 60)); service.cancel();
  assert.equal((await download).status, 'available'); assert.equal(runtime.readState().current, null);
  remote.holdDownloads = false; assert.equal((await service.download()).status, 'ready');
});

test('runtime changes require the signed installer and its bytes are rechecked before launch', async t => {
  const { service, runtime } = await connected(t, { electron: '46.0.0' });
  assert.equal((await service.check()).kind, 'installer'); assert.equal((await service.download()).status, 'ready');
  const ready = service.prepareApply(); assert.equal(ready.kind, 'installer');
  fs.appendFileSync(ready.path, 'tampered'); assert.throws(() => service.prepareApply()); assert.equal(runtime.readState().current, null);
});

test('current or older releases never offer a downgrade or fetch payload metadata', async t => {
  const { service, remote } = await connected(t, { version: '0.11.2' });
  assert.equal((await service.check()).status, 'current');
  assert.equal(remote.requests.filter(item => item.path.startsWith('/repos/Irk2wd/moye/')).length, 1);
  assert.equal(remote.requests.some(item => item.path.includes('/assets/')), false);
  await assert.rejects(() => service.download(), /检查更新/);
});

test('authorization failures are visible and leave the application unchanged', async t => {
  const { service, remote, runtime } = await connected(t); remote.unauthorized = true;
  assert.match((await service.check()).message, /读取权限/); assert.equal(runtime.readState().current, null);
  await service.credentials({ kind: 'none' }); assert.match((await service.check()).message, /先连接/);
});

test('remembered tokens are encrypted; transient tokens and renderer snapshots never persist their plaintext', async t => {
  const pair = keys(), runtime = setup(t, pair), service = new UpdateService({ runtime, encryption });
  const token = 'private-test-value'; await service.credentials({ kind: 'token', token, remember: true });
  assert.equal(fs.readFileSync(service.authFile, 'utf8').includes(token), false);
  assert.equal(JSON.stringify(service.snapshot()).includes(token), false);
  assert.equal(await new UpdateService({ runtime, encryption }).token(), token);
  await service.credentials({ kind: 'token', token, remember: false });
  await assert.rejects(() => new UpdateService({ runtime, encryption }).token());
  await service.credentials({ kind: 'none' }); await assert.rejects(() => service.token());
});

test('unavailable system encryption never falls back to plaintext storage', async t => {
  const runtime = setup(t, keys()), service = new UpdateService({ runtime, encryption: { ...encryption, available: () => false } });
  await assert.rejects(() => service.credentials({ kind: 'token', token: 'private-test-value', remember: true }), /安全存储/);
  assert.equal(fs.existsSync(service.authFile), false);
  await service.credentials({ kind: 'token', token: 'private-test-value', remember: false }); assert.equal(await service.token(), 'private-test-value');
});

test('public updates work without credentials, including download and activation with the original signing identity', async t => {
  const pair = keys(), update = fixture(pair), runtime = setup(t, pair), remote = await server(update);
  remote.publicAvailable = true; t.after(() => remote.close());
  const service = new UpdateService({ runtime, encryption, network: new GithubUpdates({ testOrigin: remote.origin }), cliToken: async () => { throw new Error('must not read private credentials'); } });
  assert.equal((await service.check()).status, 'available');
  assert.equal(service.snapshot().repository, 'Irk2wd/Meki');
  assert.equal(service.snapshot().releaseUrl, `https://github.com/Irk2wd/Meki/releases/tag/v${update.manifest.version}`);
  assert.equal((await service.download()).status, 'ready');
  assert.equal(service.prepareApply().manifest.appId, 'io.moye.editor');
  assert.ok(remote.requests.every(item => !item.authorization));
  assert.equal(remote.requests.some(item => item.path.startsWith('/repos/Irk2wd/moye/')), false);
});

test('saved private credentials are not decrypted or sent when a public release is available', async t => {
  const { service, remote } = await connected(t); remote.publicAvailable = true;
  service.cliToken = async () => { throw new Error('private CLI must not run'); };
  assert.equal((await service.check()).status, 'available');
  assert.equal((await service.download()).status, 'ready');
  assert.ok(remote.requests.every(item => !item.authorization));
});

test('migration falls back only to the authenticated legacy repository and retains its actual release URL', async t => {
  const { service, remote } = await connected(t);
  assert.equal((await service.check()).status, 'available');
  assert.equal(service.snapshot().repository, 'Irk2wd/moye');
  assert.match(service.snapshot().releaseUrl, /^https:\/\/github\.com\/Irk2wd\/moye\//);
  assert.ok(remote.requests.filter(item => item.path.startsWith('/repos/Irk2wd/Meki/')).every(item => !item.authorization));
  assert.ok(remote.requests.filter(item => item.path.startsWith('/repos/Irk2wd/moye/')).every(item => item.authorization === 'Bearer moye-test-token'));
  assert.throws(() => new GithubUpdates({ repository: 'attacker/updates' }));
  await assert.rejects(() => new GithubUpdates().response('releases/latest', 'private-value', new AbortController().signal), /不接受/);
});

test('an invalid public signature never falls back to a private release', async t => {
  const { service, remote } = await connected(t); remote.publicAvailable = true;
  const forged = fixture(keys()); remote.current.blobs.set(1, forged.blobs.get(1));
  remote.current.release.assets[0].digest = `sha256:${policy.digest(forged.blobs.get(1))}`;
  assert.match((await service.check()).message, /签名/);
  assert.equal(remote.requests.some(item => item.path.startsWith('/repos/Irk2wd/moye/')), false);
});

test('a Windows-only latest release keeps Mac updates on the newest complete Mac release', async t => {
  const pair = keys(), mac = fixture(pair, { platform: 'darwin' }), windows = fixture(pair, { platform: 'win32', version: '0.12.2' });
  const runtime = setup(t, pair, { platform: 'darwin', arch: 'arm64' }), remote = await server(mac);
  remote.publicAvailable = true; remote.latest = windows.release; remote.releases = [windows.release, mac.release];
  t.after(() => remote.close());
  const service = new UpdateService({ runtime, encryption, network: new GithubUpdates({ testOrigin: remote.origin }) });
  assert.equal((await service.check()).status, 'available');
  assert.equal(service.snapshot().latestVersion, mac.manifest.version);
  assert.equal((await service.download()).status, 'ready');
  assert.equal(service.prepareApply().manifest.platform, 'darwin');
  runtime.version = mac.manifest.version;
  assert.equal((await service.check()).status, 'current');
});

test('startup tries a signed update, acknowledges it and rolls a failed next version back to the previous healthy code', t => {
  const pair = keys(), runtime = setup(t, pair), first = fixture(pair), second = fixture(pair, { version: '0.13.0', payload: Buffer.from('second update') });
  store(runtime, first); runtime.activate(first.manifest.asarSha256);
  assert.equal(runtime.selectStartup(), runtime.paths(first.manifest.asarSha256).archive); runtime.healthy();
  store(runtime, second); runtime.activate(second.manifest.asarSha256);
  assert.equal(runtime.selectStartup(), runtime.paths(second.manifest.asarSha256).archive);
  assert.equal(runtime.selectStartup(), runtime.paths(first.manifest.asarSha256).archive);
  assert.match(runtime.message, /回退/); runtime.healthy();
});

test('a changed cached archive or manifest is rejected before executing it', t => {
  const pair = keys(), runtime = setup(t, pair), update = fixture(pair);
  store(runtime, update); runtime.activate(update.manifest.asarSha256);
  fs.writeFileSync(runtime.paths(update.manifest.asarSha256).archive, 'broken');
  assert.equal(runtime.selectStartup(), null); assert.match(runtime.message, /校验/);
  assert.equal(runtime.readState().current, null);
});

test('a newer full installation supersedes an old code update and cache identifiers cannot escape their directory', t => {
  const pair = keys(), runtime = setup(t, pair), update = fixture(pair); store(runtime, update); runtime.activate(update.manifest.asarSha256);
  runtime.baseVersion = '0.13.0'; assert.equal(runtime.selectStartup(), null); assert.equal(runtime.readState().current, null);
  assert.throws(() => runtime.paths('../outside')); assert.throws(() => runtime.paths('A'.repeat(64)));
});

test('healthy startup keeps the current and rollback archives and prunes only obsolete update files', t => {
  const pair = keys(), runtime = setup(t, pair);
  const updates = [0, 1, 2].map(index => fixture(pair, { version: `0.12.${index}`, payload: Buffer.from(`application ${index}`) }));
  fs.writeFileSync(path.join(runtime.payloads, 'unrelated.txt'), 'keep');
  for (const update of updates) { store(runtime, update); runtime.activate(update.manifest.asarSha256); runtime.selectStartup(); runtime.healthy(); }
  assert.equal(fs.existsSync(runtime.paths(updates[0].manifest.asarSha256).archive), false);
  for (const update of updates.slice(1)) assert.ok(fs.existsSync(runtime.paths(update.manifest.asarSha256).archive));
  assert.equal(fs.readFileSync(path.join(runtime.payloads, 'unrelated.txt'), 'utf8'), 'keep');
});

test('release asset generation verifies the key, exact installer and archive, and rejects substituted artifacts', async t => {
  const { createUpdateAssets, verifyUpdateAssets } = await import('../scripts/update-assets.mjs');
  const pair = keys(), runtime = setup(t, pair), source = fixture(pair);
  const asar = path.join(runtime.root, 'synthetic.asar'), installer = path.join(runtime.root, source.manifest.installer.name);
  fs.writeFileSync(asar, source.payload); fs.writeFileSync(installer, source.installer);
  const options = { directory: runtime.root, asar, installer, version: '0.12.0', platform: process.platform, electron: '45.0.0',
    signingKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), verificationKey: pair.publicKey };
  await assert.rejects(() => createUpdateAssets({ ...options, verificationKey: keys().publicKey }), /does not match/);
  const updateAssets = await createUpdateAssets(options);
  const build = { version: '0.12.0', platform: process.platform === 'win32' ? 'windows' : 'macos', asarSha256: policy.digest(source.payload),
    installer: path.basename(installer), sha256: policy.digest(source.installer), updateAssets };
  assert.equal((await verifyUpdateAssets(build, runtime.root, pair.publicKey)).asarSha256, build.asarSha256);
  await assert.rejects(() => verifyUpdateAssets({ ...build, updateAssets: [updateAssets[0], updateAssets[0]] }, runtime.root, pair.publicKey), /Missing/);
  fs.appendFileSync(installer, 'changed'); await assert.rejects(() => verifyUpdateAssets(build, runtime.root, pair.publicKey));
  fs.writeFileSync(installer, source.installer);
  fs.appendFileSync(path.join(runtime.root, source.manifest.payload.name), 'changed');
  await assert.rejects(() => verifyUpdateAssets(build, runtime.root, pair.publicKey), /checksum/);
});

test('Meki installers retain byte-identical legacy aliases and the original signed protocol', async t => {
  const { createUpdateAssets, verifyUpdateAssets } = await import('../scripts/update-assets.mjs');
  const { installerName } = require('../electron/app-identity.cjs');
  for (const platform of ['win32', 'darwin']) {
    const pair = keys(), runtime = setup(t, pair), source = fixture(pair, { version: '1.0.0', platform });
    const asar = path.join(runtime.root, 'application.asar'), installer = path.join(runtime.root, installerName('1.0.0', platform));
    fs.writeFileSync(asar, source.payload); fs.writeFileSync(installer, source.installer);
    const updateAssets = await createUpdateAssets({ directory: runtime.root, asar, installer, version: '1.0.0', platform, electron: '45.0.0',
      signingKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), verificationKey: pair.publicKey });
    const legacyName = policy.names('1.0.0', platform).installer, alias = path.join(runtime.root, legacyName);
    assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(installer));
    const build = { version: '1.0.0', platform: platform === 'win32' ? 'windows' : 'macos', installer: path.basename(installer),
      compatibilityInstaller: legacyName, sha256: policy.digest(source.installer), asarSha256: policy.digest(source.payload), updateAssets };
    const signed = await verifyUpdateAssets(build, runtime.root, pair.publicKey);
    assert.equal(signed.installer.name, legacyName); assert.equal(signed.appId, 'io.moye.editor');
    await assert.rejects(verifyUpdateAssets({ ...build, compatibilityInstaller: undefined }, runtime.root, pair.publicKey), /alias/);
    fs.writeFileSync(installer, Buffer.alloc(source.installer.length, 1));
    await assert.rejects(verifyUpdateAssets(build, runtime.root, pair.publicKey), /Primary installer/);
    fs.writeFileSync(installer, source.installer); fs.writeFileSync(alias, Buffer.alloc(source.installer.length, 2));
    await assert.rejects(verifyUpdateAssets(build, runtime.root, pair.publicKey), /checksum/);
  }
});

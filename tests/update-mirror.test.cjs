'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { APP_ID } = require('../electron/app-identity.cjs');
const { MirrorUpdates, mirrorUrl } = require('../electron/update-mirror.cjs');
const { GithubUpdates } = require('../electron/update-network.cjs');
const { names } = require('../electron/update-policy.cjs');
const { UpdateRuntime } = require('../electron/update-runtime.cjs');
const { UpdateService } = require('../electron/update-service.cjs');
const { keys, fixture, server } = require('./update-fixture.cjs');

async function setup(t, { runtimeVersion = '0.11.3', mirrorTimeout, installer = false } = {}) {
  const pair = keys();
  const update = fixture(pair, { platform: 'win32' });
  const remote = await server(update);
  t.after(() => remote.close());
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-mirror-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const { manifest, envelope, release } = update;
  remote.mirror = { tag: release.tag_name, manifest: envelope, notes: 'Mirror release notes', checkedAt: Math.floor(Date.now() / 1000) };
  const runtime = new UpdateRuntime({ userData: folder, baseVersion: runtimeVersion, platform: manifest.platform,
    electron: installer ? '44.0.0' : manifest.electron, arch: 'x64', key: pair.publicKey, nativeIcon: manifest.nativeIcon });
  const mirror = new MirrorUpdates({ testOrigin: `${remote.origin}/updates`, idleTimeout: mirrorTimeout });
  const network = new GithubUpdates({ testOrigin: remote.origin });
  const states = [];
  const service = new UpdateService({ runtime, network, mirror, notify: state => states.push(state) });
  const githubRequests = () => remote.requests.filter(request => request.path.startsWith('/repos/')).map(request => request.path);
  return { update, remote, runtime, service, states, githubRequests, pair };
}

test('mirror base URLs use HTTPS and preserve their configured path', () => {
  assert.equal(mirrorUrl('https://updates.example.org:8443/meki').href, 'https://updates.example.org:8443/meki/');
  assert.throws(() => mirrorUrl('http://127.0.0.1:8080'));
  assert.throws(() => mirrorUrl('http://updates.example.org', true));
  assert.throws(() => mirrorUrl('https://user:password@updates.example.org'));
  assert.throws(() => mirrorUrl('https://updates.example.org?t=1'));
});

test('a signed mirror release is checked and downloaded without reaching GitHub', async t => {
  const { update, remote, runtime, service, githubRequests } = await setup(t);
  remote.publicAvailable = false;
  const state = await service.check();
  assert.equal(state.status, 'available');
  assert.equal(state.notes, 'Mirror release notes');
  assert.equal(state.latestVersion, update.manifest.version);
  assert.equal(state.kind, 'payload');
  const ready = await service.download();
  assert.equal(ready.status, 'ready', ready.message);
  assert.deepEqual(await fs.readFile(runtime.paths(update.manifest.asarSha256).archive), update.payload);
  assert.deepEqual(githubRequests(), []);
});

test('mirror supports the signed full installer when the installed runtime is incompatible', async t => {
  const { update, remote, service, githubRequests } = await setup(t, { installer: true });
  remote.publicAvailable = false;
  const state = await service.check();
  assert.equal(state.kind, 'installer');
  assert.equal((await service.download()).status, 'ready');
  assert.deepEqual(await fs.readFile(service.prepareApply().path), update.installer);
  assert.deepEqual(githubRequests(), []);
});

test('a fresh mirror confirms the current version while GitHub is unreachable', async t => {
  const { update, remote, service, githubRequests } = await setup(t, { runtimeVersion: '0.12.0' });
  remote.publicAvailable = false;
  const state = await service.check();
  assert.equal(state.status, 'current', state.message);
  assert.equal(state.latestVersion, update.manifest.version);
  assert.deepEqual(githubRequests(), []);
});

test('a missing, stale or invalid mirror pointer falls back to the release API', async t => {
  const { update, remote, runtime, service, pair, githubRequests } = await setup(t);
  const pointer = remote.mirror;
  const otherEdition = APP_ID === 'io.meki.editor' ? 'io.meki.research' : 'io.meki.editor';
  const stale = fixture(pair, { version: '0.11.2', platform: runtime.platform });
  const foreign = fixture(pair, { appId: otherEdition, platform: runtime.platform });
  const wrongPlatform = fixture(pair, { platform: 'darwin' });
  const wrongSignature = fixture(keys(), { platform: runtime.platform });
  for (const candidate of [
    null,
    { ...pointer, checkedAt: pointer.checkedAt - 7200 },
    { ...pointer, tag: stale.release.tag_name, manifest: stale.envelope },
    { ...pointer, manifest: foreign.envelope },
    { ...pointer, manifest: wrongPlatform.envelope },
    { ...pointer, manifest: wrongSignature.envelope },
    { ...pointer, tag: 'v0.13.1' },
  ]) {
    remote.mirror = candidate;
    const count = githubRequests().length;
    const state = await service.check();
    assert.equal(state.status, 'available', state.message);
    assert.equal(state.notes, update.release.body);
    assert.equal(state.latestVersion, update.manifest.version);
    assert.ok(githubRequests().length > count);
  }
});

test('a corrupt or stalled mirror transfer retries the exact signed release on GitHub', async t => {
  const { update, remote, runtime, service, states, githubRequests, pair } = await setup(t, { mirrorTimeout: 180 });
  const newer = fixture(pair, { version: '0.12.1', platform: runtime.platform });
  remote.latest = newer.release;
  remote.releases = [newer.release, update.release];
  if (APP_ID === 'io.meki.research') {
    update.release.tag_name = 'mekir-' + update.release.tag_name;
    remote.mirror.tag = update.release.tag_name;
  }
  for (const { bytes, hold } of [
    { bytes: Buffer.alloc(update.compressed.length), hold: false },
    { bytes: update.compressed, hold: true },
  ]) {
    remote.mirrorBytes = bytes;
    remote.holdMirror = hold;
    states.length = 0;
    remote.requests.length = 0;
    assert.equal((await service.check()).latestVersion, update.manifest.version);
    const ready = await service.download();
    assert.equal(ready.status, 'ready', ready.message);
    assert.equal(ready.latestVersion, update.manifest.version);
    assert.deepEqual(githubRequests(), [
      '/repos/Irk2wd/Meki/releases/tags/' + update.release.tag_name,
      '/repos/Irk2wd/Meki/releases/assets/2',
    ]);
    assert.ok(states.some(state => state.downloaded === 0 && state.message.includes('GitHub')));
    assert.deepEqual(await fs.readFile(runtime.paths(update.manifest.asarSha256).archive), update.payload);
  }
});

test('canceling a mirror download leaves the same update available without failing over', async t => {
  const { update, remote, runtime, service, githubRequests } = await setup(t);
  remote.holdMirror = true;
  assert.equal((await service.check()).status, 'available');
  const transitioned = service.notify;
  service.notify = state => {
    transitioned(state);
    if (state.status === 'downloading' && state.downloaded > 0) service.cancel();
  };
  const state = await service.download();
  assert.equal(state.status, 'available', state.message);
  assert.equal(state.latestVersion, update.manifest.version);
  assert.deepEqual(githubRequests(), []);
  assert.ok((await fs.readdir(runtime.root)).every(file => !file.endsWith('.download')));
  const { manifest: filename } = names(update.manifest.version, update.manifest.platform);
  assert.equal(remote.requests[0].path, '/updates/latest/' + filename);
});

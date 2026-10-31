'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const http = require('node:http');
const { names, digest } = require('../electron/update-policy.cjs');

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function fixture(pair, { version = '0.12.0', platform = process.platform, electron = '45.0.0', payload = Buffer.from('synthetic application'), bootstrap = 1 } = {}) {
  const files = names(version, platform), compressed = zlib.gzipSync(payload), installer = Buffer.from('synthetic installer; never execute');
  const manifest = { appId: 'io.moye.editor', version, bootstrap, electron, platform, arch: platform === 'darwin' ? 'universal' : 'x64',
    asarSize: payload.length, asarSha256: digest(payload), payload: { name: files.payload, size: compressed.length, sha256: digest(compressed) },
    installer: { name: files.installer, size: installer.length, sha256: digest(installer) } };
  const body = Buffer.from(JSON.stringify(manifest)), envelope = { schema: 1, body: body.toString('base64'), signature: crypto.sign(null, body, pair.privateKey).toString('base64') };
  const blobs = new Map([[1, Buffer.from(JSON.stringify(envelope))], [2, compressed], [3, installer]]);
  const release = { tag_name: `v${version}`, published_at: '2026-10-29T00:00:00Z', draft: false, prerelease: false, body: '更新说明 <script>window.untrustedRelease=true</script>',
    assets: [files.manifest, files.payload, files.installer].map((name, index) => ({ id: index + 1, name, state: 'uploaded', size: blobs.get(index + 1).length, digest: `sha256:${digest(blobs.get(index + 1))}` })) };
  return { manifest, envelope, payload, compressed, installer, blobs, release };
}
async function server(initial) {
  const context = { current: initial, requests: [], slow: false, unauthorized: false, redirect: null, publicAvailable: false, latest: null, releases: null };
  const instance = http.createServer(async (request, response) => {
    if (request.url === '/__fixture_ready__') { response.writeHead(204).end(); return; }
    context.requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url.startsWith('/repos/')) {
      const isPublic = request.url.startsWith('/repos/Irk2wd/Meki/');
      if (isPublic && !context.publicAvailable) { response.writeHead(404).end(); return; }
      if (!isPublic && (context.unauthorized || request.headers.authorization !== 'Bearer moye-test-token')) { response.writeHead(401).end(); return; }
      if (request.url.endsWith('/releases/latest')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(context.latest || context.current.release)); return; }
      if (request.url.includes('/releases?')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(context.releases || [context.current.release])); return; }
      const id = Number(request.url.split('/').pop());
      response.writeHead(302, { Location: context.redirect || `/blob/${id}` }).end(); return;
    }
    const bytes = context.current.blobs.get(Number(request.url.split('/').pop()));
    if (!bytes) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Length', bytes.length);
    if (context.slow && request.url === '/blob/2') {
      response.write(bytes.subarray(0, 1));
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!response.destroyed) response.end(bytes.subarray(1));
    } else response.end(bytes);
  });
  context.close = () => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); });
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    context.origin = `http://127.0.0.1:${instance.address().port}`;
    try {
      // listen(0) can choose a port rejected by Fetch, including 6665–6669.
      // Check readiness before starting the app; only retry that port-policy case.
      const response = await fetch(`${context.origin}/__fixture_ready__`, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel(); return context;
    } catch (error) {
      await context.close();
      if (error.cause?.message !== 'bad port' || attempt === 15) throw error;
    }
  }
}
module.exports = { keys, fixture, server };

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { imageType } = require('../electron/file-store.cjs');
const { imageUrl, isPublicAddress, sniffImage, createImageDownloader, downloadImage } = require('../electron/image-download.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function server(t, callback) {
  const requests = [], listener = http.createServer((request, response) => { requests.push({ url: request.url, headers: request.headers }); callback(request, response); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); });
  return { requests, origin: `http://test.example:${listener.address().port}`, listener };
}
const localDownloader = () => createImageDownloader({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], allowedAddress: address => address === '127.0.0.1' });
test('URL and IP rules reject credentials, non-web protocols, control characters and nonpublic destinations', async () => {
  for (const value of ['file:///etc/passwd', 'ftp://example.com/image.png', 'https://user:pass@example.com/image', ' http://example.com/image', 'http://example.com/\nimage', 'http:\\example.com/image']) assert.throws(() => imageUrl(value));
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(downloadImage('http://127.0.0.1/image'), /内网/);
});
test('format detection uses actual bytes, supports static SVG and rejects executable or external SVG', () => {
  assert.deepEqual(sniffImage(png, imageType), { extension: '.png', mime: 'image/png' });
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), imageType).extension, '.svg');
  for (const text of ['<html><img></html>', '<svg onload="x()"></svg>', '<svg><script>alert(1)</script></svg>', '<svg><image href="http://example.com/image.png"/></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///x">]><svg></svg>']) assert.throws(() => sniffImage(Buffer.from(text), imageType));
  assert.throws(() => sniffImage(png, () => null));
});

test('static SVG checks reject namespace and CSS/XML escape bypasses', () => {
  const svg = body => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
  for (const body of [
    '<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>',
    '<界:script xmlns:界="http://www.w3.org/2000/svg">alert(1)</界:script>',
    String.raw`<style>@\69mport "https://example.test/a.css";</style>`,
    String.raw`<path style="fill: \75rl(https://example.test/a.svg)"/>`,
    '<style>@&#x69;mport "https://example.test/a.css";</style>',
    '<path style="fill: &#117;rl(https://example.test/a.svg)"/>',
    '<path style="fill: &#92;75rl(https://example.test/a.svg)"/>',
    '<style>@&#92;69mport "https://example.test/a.css";</style>',
    '<animate attributeName="href" to="https://example.test/a.svg"/>',
    '<set attributeName="style" to="color: red"/>',
    '<?xml-stylesheet type="text/css" href="https://example.test/a.css"?>',
  ]) assert.throws(() => sniffImage(svg(body), imageType), /活动内容/, body);
  assert.equal(sniffImage(svg('<path style="fill: #f00; stroke-width: 2" d="M0 0 L2 2"/><text>&#x4e2d;&#25991;</text>'), imageType).extension, '.svg');
});
test('download pins validated DNS, infers names without URL extensions and sends no ambient credentials', async t => {
  const s = await server(t, (_request, response) => response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': png.length }).end(png));
  const progress = [], result = await localDownloader()(s.origin + '/asset?id=1', { validateImage: imageType, onProgress: bytes => progress.push(bytes) });
  assert.deepEqual(result.bytes, png); assert.equal(result.name, 'asset.png'); assert.equal(result.mime, 'image/png');
  assert.equal(s.requests[0].headers.cookie, undefined); assert.equal(s.requests[0].headers.authorization, undefined); assert.equal(s.requests[0].headers['accept-encoding'], 'identity');
  assert.equal(progress.at(-1), png.length);
});
test('relative redirects are bounded and every hop receives a new address check', async t => {
  const s = await server(t, (request, response) => request.url === '/start' ? response.writeHead(302, { Location: '/image' }).end() : response.writeHead(200).end(png));
  let checks = 0;
  const download = createImageDownloader({ lookup: async () => { checks++; return [{ address: '127.0.0.1', family: 4 }]; }, allowedAddress: () => true });
  const result = await download(s.origin + '/start'); assert.equal(checks, 2); assert.ok(result.finalUrl.endsWith('/image')); assert.deepEqual(result.bytes, png);
  await assert.rejects(download(s.origin + '/start', { maxRedirects: 0 }), /重定向/);
});
test('redirects cannot reach private addresses or credential-bearing URLs', async t => {
  const s = await server(t, (request, response) => response.writeHead(302, { Location: request.url === '/auth' ? 'http://user:pass@example.com/image' : 'http://127.0.0.1/private' }).end());
  let checks = 0;
  const download = createImageDownloader({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], allowedAddress: () => ++checks === 1 });
  await assert.rejects(download(s.origin + '/private'), /内网/); assert.equal(s.requests.length, 1);
  await assert.rejects(localDownloader()(s.origin + '/auth'), /账号密码/);
});
test('oversized declared and streamed responses, unsupported encoding and non-images leave no result', async t => {
  const s = await server(t, (request, response) => {
    if (request.url === '/length') response.writeHead(200, { 'Content-Length': 999 }).end(png);
    else if (request.url === '/encoding') response.writeHead(200, { 'Content-Encoding': 'gzip' }).end(png);
    else if (request.url === '/html') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>login</html>');
    else { response.writeHead(200); response.write(png); response.end(png); }
  });
  const download = localDownloader();
  await assert.rejects(download(s.origin + '/length', { maxBytes: png.length }), /大小/);
  await assert.rejects(download(s.origin + '/stream', { maxBytes: png.length }), /大小/);
  await assert.rejects(download(s.origin + '/encoding'), /编码/);
  await assert.rejects(download(s.origin + '/html'), /不是支持的图片/);
});
test('cancel and timeout abort response waiting, while pre-canceled requests never access the network', async t => {
  const s = await server(t, () => {}), download = localDownloader(), controller = new AbortController();
  const pending = download(s.origin + '/cancel', { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, /取消/);
  await assert.rejects(download(s.origin + '/timeout', { timeoutMs: 25 }), /超时/);
  const before = s.requests.length;
  await assert.rejects(download(s.origin + '/never', { signal: controller.signal }), /取消/);
  assert.equal(s.requests.length, before);
});
test('canceling during response streaming closes the active request without returning partial bytes', async t => {
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  const s = await server(t, (_request, response) => {
    response.writeHead(200); response.write(png.subarray(0, 12));
    response.on('close', closed);
  });
  const controller = new AbortController();
  await assert.rejects(localDownloader()(s.origin + '/stream', { signal: controller.signal, onProgress: () => controller.abort() }), /取消/);
  await done;
});
test('DNS failures, mixed public/private DNS answers and stalled DNS resolution fail before requests', async () => {
  const mixed = createImageDownloader({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(mixed('https://example.com/image'), /内网/);
  const stalled = createImageDownloader({ lookup: () => new Promise(() => {}) });
  // Keep a live handle because production DNS itself keeps Node running while the timeout is unref'ed.
  const hold = setInterval(() => {}, 1000);
  try { await assert.rejects(stalled('https://example.com/image', { timeoutMs: 20 }), /超时/); } finally { clearInterval(hold); }
  const failed = createImageDownloader({ lookup: async () => { throw Error('DNS failure'); } });
  await assert.rejects(failed('https://example.com/image'), /DNS failure/);
});

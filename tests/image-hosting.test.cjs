const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { ImageHosting } = require('../electron/image-hosting.cjs');
const { digest, pathKey, isWithin } = require('../electron/file-store.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const input = () => [{ name: '图 片.png', bytes: png }];
const urls = count => Array.from({ length: count }, (_, index) => `https://images.example.test/${index}.png?key=from-picgo`);

async function temporary(t, prefix) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.realpath(await fs.mkdtemp(path.join(parent, prefix)));
  t.after(async () => {
    const target = await fs.realpath(root);
    assert.equal(pathKey(path.dirname(target)), pathKey(parent));
    assert.ok(path.basename(target).startsWith(prefix));
    await fs.rm(target, { recursive: true, force: true });
  });
  return root;
}
async function remote(t) {
  let received;
  const state = { requests: [], files: [], respond: null, heartbeatStatus: 200, uploaded: new Promise(resolve => { received = resolve; }) };
  const server = http.createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}');
      const entry = { method: request.method, path: request.url, type: request.headers['content-type'], body };
      state.requests.push(entry);
      if (request.url === '/heartbeat') {
        response.writeHead(state.heartbeatStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, result: 'alive' })); return;
      }
      if (request.url !== '/upload') { response.writeHead(404).end(); return; }
      for (const file of body.list || []) state.files.push({ path: file, bytes: await fs.readFile(file) });
      received(entry);
      if (state.respond) { await state.respond(entry, response); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ success: true, result: urls(body.list.length) }));
    } catch { if (!response.destroyed) response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return state;
}
async function fixture(t, options = {}) {
  const root = await temporary(t, 'meki-hosting-'), service = await remote(t);
  const doc = path.join(root, '文稿.md'), picture = path.join(root, '原 图.png'), scratch = path.join(root, 'upload-temp');
  const raw = Buffer.from('\uFEFF# 原文\r\n\r\n![本地](原%20图.png)\r\n');
  await fs.writeFile(doc, raw); await fs.writeFile(picture, png);
  const configuration = { picgoPort: service.port };
  const hosting = new ImageHosting({
    authorize: value => { assert.equal(pathKey(value), pathKey(doc), 'document must be authorized'); return value; },
    boundary: async () => root, settings: () => configuration, tempRoot: scratch, ...options,
  });
  const prepare = sources => hosting.prepare({ documentPath: doc, revision: digest(raw), sources });
  const clean = async () => assert.deepEqual(await fs.readdir(scratch).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
  return { root, service, doc, picture, scratch, raw, configuration, hosting, prepare, clean };
}

test('PicGo connection checks use only the heartbeat and never upload clipboard content', async t => {
  const f = await fixture(t);
  assert.match(await f.hosting.check(), /连接正常/);
  assert.deepEqual(f.service.requests, [{ method: 'POST', path: '/heartbeat', type: 'application/json', body: {} }]);
  await f.clean();
  f.service.heartbeatStatus = 404;
  await assert.rejects(f.hosting.check(), /不支持无上传检测/);
  assert.ok(f.service.requests.every(request => request.path === '/heartbeat'));
  await assert.rejects(f.hosting.uploadImages([]), /1–32/);
  assert.equal(f.service.requests.length, 2, 'an empty list must never reach /upload');
});

test('preview is read-only; manual uploads deduplicate paths and embedded images while retaining originals', async t => {
  const f = await fixture(t), data = `data:image/png;base64,${png.toString('base64')}`;
  const sources = ['原%20图.png?width=10#crop', pathToFileURL(f.picture).href, './原%20图.png', data, data + '#view', 'https://remote.invalid/image.png'];
  const plan = await f.prepare(sources);
  assert.equal(plan.count, 2); assert.equal(plan.remote, 1); assert.equal(plan.bytes, png.length * 2);
  assert.deepEqual(plan.names, ['原 图.png', 'image.png']);
  assert.equal(f.service.requests.length, 0); await f.clean();
  const mapping = await f.hosting.uploadPrepared(plan.id);
  assert.deepEqual(mapping, sources.slice(0, -1).map((source, index) => ({ source, url: urls(2)[index < 3 ? 0 : 1] })));
  assert.equal(f.service.requests.length, 1); assert.equal(f.service.requests[0].path, '/upload');
  assert.equal(f.service.requests[0].type, 'application/json');
  assert.equal(f.service.requests[0].body.list.length, 2);
  for (const file of f.service.files) {
    assert.equal(path.isAbsolute(file.path), true);
    assert.equal(pathKey(path.dirname(path.dirname(file.path))), pathKey(f.scratch));
    assert.notEqual(pathKey(file.path), pathKey(f.picture)); assert.deepEqual(file.bytes, png);
  }
  assert.deepEqual(await fs.readFile(f.doc), f.raw); assert.deepEqual(await fs.readFile(f.picture), png); await f.clean();
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /失效/);
});

test('inserted image bytes upload without a document path and return validated URL order', async t => {
  const f = await fixture(t), images = [...input(), { name: '另一个.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }];
  assert.deepEqual(await f.hosting.uploadImages(images), urls(2));
  assert.deepEqual(f.service.files.map(file => file.bytes), images.map(image => image.bytes));
  assert.deepEqual(await fs.readFile(f.doc), f.raw); assert.deepEqual(await fs.readFile(f.picture), png); await f.clean();
});

test('remote-only and empty document plans make no request and create no upload files', async t => {
  const f = await fixture(t);
  for (const sources of [[], ['https://never-fetch.invalid/image.png']]) {
    const plan = await f.prepare(sources); assert.equal(plan.count, 0);
    assert.deepEqual(await f.hosting.uploadPrepared(plan.id), []);
  }
  assert.equal(f.service.requests.length, 0); await f.clean();
});

test('unauthorized documents, traversal, protected paths, junctions and non-image content cannot be uploaded', async t => {
  const f = await fixture(t), outside = await temporary(t, 'meki-hosting-outside-');
  await fs.writeFile(path.join(outside, 'secret.png'), png);
  await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(f.root, '.git')); await fs.writeFile(path.join(f.root, '.git', 'secret.png'), png);
  await fs.writeFile(path.join(f.root, 'fake.png'), 'not image data');
  for (const source of [path.join(outside, 'secret.png'), '../outside.png', 'linked/secret.png', '.git/secret.png', 'fake.png', 'javascript:alert(1)', '//host/image.png', 'data:text/html;base64,SGk=', 'data:image/png;base64,SGk=']) await assert.rejects(f.prepare([source]));
  await assert.rejects(f.hosting.prepare({ documentPath: path.join(f.root, 'other.md'), revision: digest(f.raw), sources: [] }), /authorized/);
  assert.equal(f.service.requests.length, 0); assert.deepEqual(await fs.readFile(path.join(outside, 'secret.png')), png); await f.clean();
});

test('image count, total bytes, individual bytes, malformed inputs and endpoint settings are bounded before requests', async t => {
  const f = await fixture(t, { limits: { images: 2, image: png.length, bytes: png.length + 1 } });
  await fs.writeFile(path.join(f.root, 'second.png'), png);
  for (const images of [null, [{}], Array(3).fill(input()[0]), [...input(), ...input()], [{ name: 'x.png', bytes: Buffer.concat([png, Buffer.from('extra')]) }], [{ name: 'x.png', bytes: 'not bytes' }], [{ name: 'x.exe', bytes: png }]]) await assert.rejects(f.hosting.uploadImages(images));
  await assert.rejects(f.prepare(['原%20图.png', 'second.png']), /80 MiB/);
  await assert.rejects(f.hosting.prepare({ documentPath: f.doc, revision: null, sources: [] }));
  await assert.rejects(f.prepare(Array(257).fill('原%20图.png')));
  for (const port of ['36677', 0, 65536, 1.5, 'http://example.test']) {
    f.configuration.picgoPort = port;
    await assert.rejects(f.hosting.check(), /端口/); await assert.rejects(f.hosting.uploadImages(input()), /端口/);
  }
  assert.equal(f.service.requests.length, 0); await f.clean();
});

test('changes to the document, image, workspace or port invalidate prepared uploads before sending', async t => {
  const f = await fixture(t);
  let plan = await f.prepare(['原%20图.png']); await fs.writeFile(f.doc, 'changed document');
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /其他程序修改/);
  assert.equal(await fs.readFile(f.doc, 'utf8'), 'changed document'); await fs.writeFile(f.doc, f.raw);
  plan = await f.prepare(['原%20图.png']); await fs.writeFile(f.picture, Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /预览后已变化/); await fs.writeFile(f.picture, png);
  plan = await f.prepare(['原%20图.png']); f.hosting.boundary = async () => path.join(f.root, 'another');
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /工作区已切换/); f.hosting.boundary = async () => f.root;
  plan = await f.prepare(['原%20图.png']); f.configuration.picgoPort = f.service.port === 65535 ? 36677 : f.service.port + 1;
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /端口已变化/);
  assert.equal(f.service.requests.length, 0); await f.clean();
});

test('external document changes during transfer reject results without overwriting the new bytes', async t => {
  const f = await fixture(t), plan = await f.prepare(['原%20图.png']);
  f.service.respond = async (entry, response) => {
    await fs.writeFile(f.doc, 'new bytes from another program');
    response.end(JSON.stringify({ success: true, result: urls(entry.body.list.length) }));
  };
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /其他程序修改.*可能已上传/);
  assert.equal(await fs.readFile(f.doc, 'utf8'), 'new bytes from another program');
  assert.deepEqual(await fs.readFile(f.picture), png); await f.clean();
});

test('external image changes during transfer reject results and preserve the newer original', async t => {
  const f = await fixture(t), plan = await f.prepare(['原%20图.png']), changed = Buffer.concat([png, Buffer.from('new image version')]);
  f.service.respond = async (entry, response) => {
    await fs.writeFile(f.picture, changed);
    response.end(JSON.stringify({ success: true, result: urls(entry.body.list.length) }));
  };
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /图片在上传期间已变化.*可能已上传/);
  assert.deepEqual(f.service.files[0].bytes, png, 'the request used the verified snapshot, never the changed source');
  assert.deepEqual(await fs.readFile(f.picture), changed); assert.deepEqual(await fs.readFile(f.doc), f.raw); await f.clean();
});

test('a request directory replaced before send is rejected without reading or posting through the link', async t => {
  const f = await fixture(t), outside = await temporary(t, 'meki-hosting-swapped-'), plan = await f.prepare(['原%20图.png']);
  const validate = f.hosting.validateDocument.bind(f.hosting); let checks = 0;
  f.hosting.validateDocument = async value => {
    await validate(value);
    if (++checks !== 2) return;
    const scratch = await fs.realpath(f.scratch), directory = path.join(scratch, (await fs.readdir(scratch))[0]), retained = path.join(scratch, 'retained-original');
    assert.ok(isWithin(await fs.realpath(directory), scratch)); assert.ok(isWithin(path.resolve(retained), scratch));
    await fs.rename(directory, retained);
    await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  };
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /临时目录已变化/);
  assert.equal(f.service.requests.length, 0); assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readFile(f.picture), png); assert.deepEqual(await fs.readFile(f.doc), f.raw);
});

test('failed or partial PicGo responses never return partial mappings or expose response text', async t => {
  const f = await fixture(t);
  const replies = [{ success: false, result: urls(1), message: 'secret-provider-token' }, { success: true, result: [] }, { success: true, result: [urls(1)[0], urls(1)[0]] }, { success: true, result: 'https://images.example.test/a.png' }, null];
  for (const reply of replies) {
    f.service.respond = async (_entry, response) => response.end(JSON.stringify(reply));
    await assert.rejects(f.hosting.uploadImages(input()), error => /未应用上传结果/.test(error.message) && !error.message.includes('secret-provider-token'));
    await f.clean();
  }
  assert.equal(f.service.requests.length, replies.length, 'failure must not retry uploads');
  assert.deepEqual(await fs.readFile(f.picture), png);
});

test('non-HTTP, credential-bearing, malformed and oversized URLs are rejected', async t => {
  const f = await fixture(t);
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///secret.png', '//example.test/a.png', 'https:example.test/a.png', 'https://user:secret@example.test/a.png', 'https://example.test/a\n.png', 'not a url', '', 'https://example.test/' + 'x'.repeat(8200)]) {
    f.service.respond = async (_entry, response) => response.end(JSON.stringify({ success: true, result: [value] }));
    await assert.rejects(f.hosting.uploadImages(input()), /图片地址/); await f.clean();
  }
});

test('redirects, invalid JSON, HTTP errors and oversized responses fail without following another endpoint', async t => {
  const f = await fixture(t);
  f.service.respond = async (_entry, response) => response.writeHead(302, { Location: `http://127.0.0.1:${f.service.port}/unexpected` }).end();
  await assert.rejects(f.hosting.uploadImages(input()), /重定向/);
  f.service.respond = async (_entry, response) => response.end('<html>private provider diagnostics</html>');
  await assert.rejects(f.hosting.uploadImages(input()), /无效结果/);
  f.service.respond = async (_entry, response) => response.writeHead(500).end('secret-provider-token');
  await assert.rejects(f.hosting.uploadImages(input()), error => error.message.includes('500') && !error.message.includes('secret-provider-token'));
  f.service.respond = async (_entry, response) => response.end('x'.repeat(512 * 1024 + 1));
  await assert.rejects(f.hosting.uploadImages(input()), /结果过大/);
  assert.equal(f.service.requests.length, 4); assert.ok(f.service.requests.every(request => request.path === '/upload')); await f.clean();
});

test('cancellation rejects overlapping work, cleans temporary copies and never retries by itself', async t => {
  const f = await fixture(t);
  f.service.respond = async () => {};
  const upload = f.hosting.uploadImages(input()); await f.service.uploaded;
  await assert.rejects(f.hosting.check(), /正在进行/); await assert.rejects(f.hosting.uploadImages(input()), /正在进行/);
  f.hosting.cancel(); await assert.rejects(upload, /已取消.*可能已上传/);
  assert.equal(f.service.requests.length, 1); await f.clean();
  f.service.respond = null; assert.deepEqual(await f.hosting.uploadImages(input()), urls(1));
  assert.equal(f.service.requests.length, 2); await f.clean();
});

test('upload timeout preserves originals and cleans request files without assuming server rollback', async t => {
  const f = await fixture(t, { timeoutMs: 80 }); f.service.respond = async () => {};
  await assert.rejects(f.hosting.uploadImages(input()), /超时.*可能已上传/);
  assert.equal(f.service.requests.length, 1); await f.clean();
  assert.deepEqual(await fs.readFile(f.picture), png); assert.deepEqual(await fs.readFile(f.doc), f.raw);
});

test('abandon invalidates previews, cancels in-flight requests and cannot resurrect an unfinished preview', async t => {
  const f = await fixture(t), plan = await f.prepare(['原%20图.png']);
  f.hosting.abandon(); await assert.rejects(f.hosting.uploadPrepared(plan.id), /失效/);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.hosting.boundary = async () => { entered(); await gate; return f.root; };
  const preparing = f.prepare(['原%20图.png']); await waiting; f.hosting.abandon(); release();
  await assert.rejects(preparing, /已取消/); assert.equal(f.hosting.plan, null);
  f.service.respond = async () => {};
  const upload = f.hosting.uploadImages(input()); await f.service.uploaded; f.hosting.abandon();
  await assert.rejects(upload, /已取消/); await f.clean();
});

test('stale capabilities expire and temporary cleanup leaves unexpected files untouched', async t => {
  const f = await fixture(t), plan = await f.prepare(['原%20图.png']); f.hosting.plan.expires = 0;
  await assert.rejects(f.hosting.uploadPrepared(plan.id), /过期/); assert.equal(f.service.requests.length, 0);
  let untouched;
  f.service.respond = async (entry, response) => {
    untouched = path.join(path.dirname(entry.body.list[0]), 'external-file.txt'); await fs.writeFile(untouched, 'keep this');
    response.end(JSON.stringify({ success: true, result: urls(1) }));
  };
  assert.deepEqual(await f.hosting.uploadImages(input()), urls(1));
  assert.equal(await fs.readFile(untouched, 'utf8'), 'keep this');
  assert.deepEqual(await fs.readdir(path.dirname(untouched)), ['external-file.txt']);
});

test('a linked temporary root is refused without writing or posting any images', async t => {
  const f = await fixture(t), outside = await temporary(t, 'meki-hosting-temp-outside-');
  await fs.symlink(outside, f.scratch, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.hosting.uploadImages(input()), /临时目录/);
  assert.equal(f.service.requests.length, 0); assert.deepEqual(await fs.readdir(outside), []);
});

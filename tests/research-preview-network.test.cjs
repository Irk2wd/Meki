'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter, once} = require('node:events');
const childProcess = require('node:child_process');
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const {endpoint, PreviewDAV} = require('../electron/research-preview-dav.cjs');
const {groupHost} = require('./research-group-host.cjs');

const ip = '100.70.1.8', ipv6 = 'fd7a:115c:a1e0::8', name = 'node.lab.ts.net';

function probe(t, errorCode) {
  return t.mock.method(tls, 'connect', (options, connected) => {
    assert.equal(options.rejectUnauthorized, true);
    const socket = new EventEmitter();
    socket.destroy = () => {};
    queueMicrotask(() => errorCode ? socket.emit('error', Object.assign(Error(), {code:errorCode})) : connected());
    return socket;
  });
}

function whois(t, node) {
  return t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    assert.deepEqual(args.slice(0, 2), ['whois', '--json']);
    callback(null, JSON.stringify({Node:node}));
  });
}

test('bare IP endpoints default to HTTPS and retain project directories and ports', () => {
  assert.equal(endpoint(' 100.70.1.8:7443/lab '), 'https://100.70.1.8:7443/lab/');
  assert.equal(endpoint('192.168.1.8'), 'https://192.168.1.8/');
  assert.equal(endpoint('[' + ipv6 + ']:8443/lab'), 'https://[' + ipv6 + ']:8443/lab/');
  assert.equal(endpoint(ipv6), 'https://[' + ipv6 + ']/');
  assert.equal(endpoint('https://host.example:9443/'), 'https://host.example:9443/');
  for (const url of ['http://' + ip, 'https://reader@' + ip, ip + ':99999', ip + '/?secret', ip + ':9443/#x']) {
    assert.throws(() => endpoint(url), /HTTPS/);
  }
});

test('verified Tailscale IPv4 and IPv6 connect to the input address with the authenticated peer name', async t => {
  const host = await groupHost();
  t.after(() => host.close());
  const probes = probe(t, 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR');
  const local = whois(t, {Name:name + '.', Addresses:[ip + '/32', 'fd7a:115c:a1e0:0:0:0:0:8/128']});
  const wire = t.mock.method(https, 'request', (url, options, onResponse) => {
    assert.ok([ip, '[' + ipv6 + ']'].includes(url.hostname));
    assert.equal(url.port, '7443');
    assert.equal(options.servername, name);
    assert.equal(options.headers.Host, name + ':7443');
    assert.equal(options.rejectUnauthorized, true);
    return http.request(new URL(url.pathname, host.url), {method:options.method, headers:options.headers}, onResponse);
  });
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected second destination'));
  for (const address of [ip, '[' + ipv6 + ']']) {
    const dav = new PreviewDAV(address + ':7443', 'member', 'test-only');
    const catalog = JSON.parse((await dav.read('_mekir/accounts/member.json', 65536)).bytes);
    assert.equal(catalog.projects.length, 2);
    assert.equal(JSON.parse((await dav.read('trees/latest.json', 4096)).bytes).projectId, 'forest');
    await assert.rejects(dav.read('https://external.example/file', 1000), /服务器地址范围/);
    host.state.catalogStatus = 307;
    await assert.rejects(dav.read('_mekir/accounts/member.json', 65536), {status:307});
    host.state.catalogStatus = 200;
  }
  assert.deepEqual(probes.mock.calls.map(c => c.arguments[0].host), [ip, ipv6]);
  assert.deepEqual(local.mock.calls.map(c => c.arguments[1][2]), [ip, ipv6]);
  assert.equal(wire.mock.callCount(), 6);
});

test('a valid IP certificate uses direct HTTPS; other IPs and hostnames do not invoke Tailscale', async t => {
  const probes = probe(t);
  const local = whois(t, {});
  const direct = t.mock.method(globalThis, 'fetch', async () => new Response(null, {status:401}));
  for (const address of [ip + ':9443', '192.168.1.8', 'https://host.example']) {
    const dav = new PreviewDAV(address, 'member', 'test-only');
    await assert.rejects(dav.read('latest.json', 4096), {status:401});
  }
  assert.deepEqual(direct.mock.calls.map(c => c.arguments[0].hostname), [ip, '192.168.1.8', 'host.example']);
  assert.equal(probes.mock.callCount(), 1);
  assert.equal(local.mock.callCount(), 0);
});

test('subnet routes, mismatched peers and DNS hints never authorize a request', async t => {
  probe(t, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const node = {Name:name, Addresses:[ip + '/24'], AllowedIPs:[ip + '/32']};
  whois(t, node);
  const wire = t.mock.method(https, 'request', () => assert.fail('unexpected HTTP request'));
  const direct = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected HTTP request'));
  t.mock.method(dns, 'lookupService', async () => ({hostname:name}));
  const forward = t.mock.method(dns, 'lookup', async () => [{address:ip, family:4}]);
  const dav = new PreviewDAV(ip + ':7443/lab/', 'member', 'test-only');
  await assert.rejects(dav.read('latest.json', 4096), e => e.message.includes('https://' + name + ':7443/lab/') && !e.message.includes('test-only'));
  forward.mock.mockImplementation(async () => [{address:'100.70.1.9', family:4}]);
  node.Addresses = ['100.70.1.9/32'];
  await assert.rejects(dav.send('PUT', 'change', {body:'x'}), /无法确认/);
  node.Addresses = [ip + '/32'];
  node.Name = 'external.example';
  await assert.rejects(dav.send('PUT', 'change', {body:'x'}), /无法确认/);
  assert.equal(wire.mock.callCount(), 0);
  assert.equal(direct.mock.callCount(), 0);
});

test('a verified peer still requires a matching certificate and a failed write is never replayed', async t => {
  probe(t, 'ECONNRESET');
  whois(t, {Name:name, Addresses:[ip + '/32']});
  const wire = t.mock.method(https, 'request', (url, options) => {
    assert.equal(options.servername, name);
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter();
    request.end = () => request.emit('error', Object.assign(Error(), {code:'ERR_TLS_CERT_ALTNAME_INVALID'}));
    return request;
  });
  const direct = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected retry'));
  const dav = new PreviewDAV(ip + ':7443', 'member', 'test-only');
  await assert.rejects(dav.send('PUT', 'pending.json', {body:'x'}), /HTTPS 握手失败/);
  assert.equal(wire.mock.callCount(), 1);
  assert.equal(direct.mock.callCount(), 0);
});

test('publishing by IP uses the verified HTTP authority for the conditional WebDAV move', async t => {
  probe(t, 'ECONNRESET');
  whois(t, {Name:name, Addresses:[ip + '/32']});
  const moves = [], previous = 'a'.repeat(64);
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'GET' && req.url === '/lab/latest.json') {
      res.writeHead(200, {ETag:'"first"'});
      return res.end(JSON.stringify({format:'mekir-preview/1', projectId:'forest', revision:previous, publishedAt:'2026-11-20T10:00:00Z'}));
    }
    if (req.method === 'MOVE') moves.push(req.headers);
    res.writeHead(req.method === 'HEAD' ? 404 : 201);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  t.mock.method(https, 'request', (url, options, onResponse) =>
    http.request({host:'127.0.0.1', port:server.address().port, path:url.pathname, method:options.method, headers:options.headers}, onResponse));
  const dav = new PreviewDAV(ip + ':7443/lab/', 'member', 'test-only');
  const next = await dav.publish({snapshot:{project:{id:'forest'}}, revision:'b'.repeat(64), bytes:Buffer.from('{}'), media:new Map()});
  assert.equal(next.previous, previous);
  assert.equal(moves.length, 1);
  const destination = 'https://' + name + ':7443/lab/latest.json';
  assert.equal(moves[0].host, name + ':7443');
  assert.equal(moves[0].destination, destination);
  assert.equal(moves[0].if, '<' + destination + '> (["first"])');
});

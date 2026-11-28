'use strict';

const { randomUUID } = require('node:crypto');
const { digest } = require('./file-store.cjs');
const { assert } = require('./research-model.cjs');
const { version, maxSnapshot, maxThumbnail, maxMediaBytes, validatePointer, validateSnapshot, mediaHashes, mediaName, imageFormat } = require('./research-preview-model.cjs');

function endpoint(input) {
  const url = new URL(input);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  assert((url.protocol === 'https:' || (local && url.protocol === 'http:')) && !url.username && !url.password && !url.search && !url.hash,
    '请填写 HTTPS WebDAV 项目目录地址，账号和密码请单独填写。');
  url.pathname = url.pathname.replace(/\/?$/, '/');
  return url.href;
}

class PreviewDAV {
  constructor(url, username, password) {
    this.base = endpoint(url);
    this.headers = { 'Cache-Control':'no-cache' };
    if (username) this.headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }
  async request(method, name, options = {}) {
    const res = await fetch(new URL(name, this.base), {method, redirect:'error', signal:AbortSignal.timeout(30000),
      headers:{...this.headers, ...options.headers}, body:options.body});
    if (!res.ok && !options.allow?.includes(res.status)) {
      await res.body?.cancel();
      const message = res.status === 401 || res.status === 403 ? '请检查账号和目录权限。' : res.status === 412 ? '发布期间远端已更新，请刷新后重试。' : '';
      throw Error(`WebDAV ${method} · HTTP ${res.status} ${message}`.trim());
    }
    return res;
  }
  async send(method, name, options) {
    const res = await this.request(method, name, options);
    await res.body?.cancel();
    return res.status;
  }
  async read(name, limit, optional = false) {
    const res = await this.request('GET', name, {allow:optional ? [404] : []});
    if (res.status === 404) { await res.body?.cancel(); return null; }
    const chunks = [];
    let size = 0;
    for await (const part of res.body) {
      size += part.length;
      if (size > limit) throw Error('远程预览文件超出大小限制。');
      chunks.push(part);
    }
    return {bytes:Buffer.concat(chunks,size), etag:res.headers.get('etag')};
  }
  async pointer(optional = false) {
    const file = await this.read('latest.json', 4096, optional);
    return file && {pointer:validatePointer(JSON.parse(file.bytes)), etag:file.etag};
  }
  async snapshot(hash, projectId) {
    const { bytes } = await this.read(`snapshots/${hash}.json`, maxSnapshot);
    assert(digest(bytes) === hash, '快照校验失败。');
    return validateSnapshot(JSON.parse(bytes), projectId);
  }
  async immutable(name, bytes, contentType) {
    const existing = await this.request('HEAD', name, {allow:[404]});
    if (existing.status === 404 || Number(existing.headers.get('content-length')) !== bytes.length) {
      await this.send('PUT', name, {body:bytes, headers:{'Content-Type':contentType}});
    }
  }
  async publish(built, {verifyExisting = false} = {}) {
    const {snapshot, revision, bytes, media} = built;
    const before = await this.pointer(true);
    assert(!before || before.pointer.projectId === snapshot.project.id, '这个地址已经用于其他项目，请选择另一个目录。');
    if (!verifyExisting && before?.pointer.revision === revision) return before.pointer;
    for (const directory of ['', 'snapshots/', 'media/']) {
      await this.send('MKCOL', directory, {allow:[405]});
    }
    const next = {format:version, projectId:snapshot.project.id, revision, publishedAt:new Date().toISOString(),
      ...(before && {previous:before.pointer.revision})};
    const pending = `pending-${randomUUID()}.json`;
    await this.send('PUT', pending, {body:JSON.stringify(next), headers:{'Content-Type':'application/json'}});
    const destination = new URL('latest.json', this.base).href;
    try {
      for (const [hash, data] of media) await this.immutable('media/'+mediaName(snapshot,hash), data, 'image/'+imageFormat(data));
      await this.immutable(`snapshots/${revision}.json`, bytes, 'application/json');
      if (before?.pointer.revision === revision) {
        await this.send('DELETE', pending, {allow:[404]});
        return before.pointer;
      }
      const current = await this.pointer(true);
      assert(current?.pointer.revision === before?.pointer.revision, '发布期间远端已更新，请重试。');
      const headers = {Destination:destination, Overwrite:before ? 'T' : 'F'};
      if (before?.etag && /^"[^"\r\n]*"$/.test(before.etag)) headers.If = `<${destination}> ([${before.etag}])`;
      await this.send('MOVE', pending, {headers});
    } catch (error) {
      await this.send('DELETE', pending, {allow:[404]}).catch(() => {});
      throw error;
    }
    return next;
  }
  async download(projectId, cache, previous) {
    const {pointer} = await this.pointer();
    assert(!projectId || projectId === pointer.projectId, '远程目录的项目 ID 不匹配。请核对迁移地址。');
    const same = previous?.pointer.revision === pointer.revision;
    const snapshot = same ? previous.snapshot : await this.snapshot(pointer.revision, pointer.projectId);
    let size = 0;
    for (const hash of mediaHashes(snapshot)) {
      const local = await cache.get(hash);
      if (local) size += local.length;
      else {
        const {bytes} = await this.read('media/'+mediaName(snapshot,hash), maxThumbnail);
        assert(digest(bytes) === hash && imageFormat(bytes) === (snapshot.mediaTypes?.[hash] || 'png'), '缩略图校验失败。');
        size += bytes.length;
        assert(size <= maxMediaBytes,'项目缩略图总量超出限制。');
        await cache.put(hash, bytes);
      }
      assert(size <= maxMediaBytes,'项目缩略图总量超出限制。');
    }
    return same && previous.pointer.publishedAt === pointer.publishedAt ? previous : {pointer,snapshot};
  }
}
module.exports = {endpoint, PreviewDAV};

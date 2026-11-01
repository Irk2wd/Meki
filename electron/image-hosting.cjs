'use strict';
const { t } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WorkspaceStore } = require('./workspace-store.cjs');
const { boundedRead, embedded, localSource } = require('./attachment-store.cjs');
const { validateAbsolutePath, isDocumentPath, pathKey, digest, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, imageType } = require('./file-store.cjs');
const { MAX_IMAGE_COUNT, MAX_BATCH_BYTES } = require('./image-input.cjs');

const RESPONSE_LIMIT = 512 * 1024;
const PLAN_LIFETIME = 5 * 60 * 1000;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const cancelled = () => new Error(t("图片上传操作已取消。"));

function checkedUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error(t("PicGo 返回了无效的图片地址。"));
  let url;
  try { url = new URL(value); } catch { throw new Error(t("PicGo 返回了无效的图片地址。")); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error(t("PicGo 返回了不支持的图片地址。"));
  return url.href;
}

class ImageHosting {
  // All callbacks and test limits are supplied by main/tests, never by renderer input.
  constructor({ authorize, boundary, settings, tempRoot, timeoutMs = 90000, checkTimeoutMs = 5000, limits = {} }) {
    Object.assign(this, { authorize, boundary, settings, timeoutMs, checkTimeoutMs });
    this.tempRoot = validateAbsolutePath(tempRoot);
    this.limits = { images: MAX_IMAGE_COUNT, image: MAX_IMAGE_BYTES, bytes: MAX_BATCH_BYTES, ...limits };
    this.plan = null; this.active = null;
  }
  port() {
    const port = this.settings().picgoPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("PicGo 端口需为 1–65535 的整数。"));
    return port;
  }
  ensureActive(active) { if (active.controller.signal.aborted) throw cancelled(); }
  async serial(action) {
    if (this.active) throw new Error(t("图片上传操作正在进行，请先取消或等待完成。"));
    const active = this.active = { controller: new AbortController(), sent: false };
    try { const result = await action(active); this.ensureActive(active); return result; }
    catch (error) {
      const message = active.controller.signal.aborted ? cancelled().message : error.message;
      throw new Error(message + (active.sent ? t(" 未应用上传结果；PicGo 可能已上传部分图片，请在 PicGo 中检查。") : ''));
    } finally { if (this.active === active) this.active = null; }
  }
  cancel() { this.active?.controller.abort(); }
  abandon() { this.plan = null; this.cancel(); }

  async request(route, body, port, active) {
    this.ensureActive(active);
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(route === 'heartbeat' ? this.checkTimeoutMs : this.timeoutMs)]);
    let response;
    if (route === 'upload') active.sent = true;
    try {
      response = await fetch(`http://127.0.0.1:${port}/${route}`, {
        method: 'POST', redirect: 'manual', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      if (active.controller.signal.aborted) throw cancelled();
      if (signal.aborted) throw new Error(t("等待 PicGo 响应超时，请检查 PicGo 的上传状态。"));
      throw new Error(t("无法连接 PicGo，请启动 PicGo、开启 Server 并核对端口。"));
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (route === 'heartbeat' && response.status === 404) throw new Error(t("当前 PicGo 不支持无上传检测，请升级 PicGo 后重试；未发送任何图片。"));
      if (response.status >= 300 && response.status < 400) throw new Error(t("PicGo 服务返回了重定向，已停止请求。"));
      throw new Error(t("PicGo 服务返回错误（{0}），请查看 PicGo 日志。", response.status));
    }
    if (!response.body) throw new Error(t("PicGo 未返回有效结果。"));
    if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { await response.body.cancel(); throw new Error(t("PicGo 返回结果过大。")); }
    const chunks = []; let length = 0;
    try {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > RESPONSE_LIMIT) throw new Error(t("PicGo 返回结果过大。"));
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (active.controller.signal.aborted) throw cancelled();
      if (signal.aborted) throw new Error(t("等待 PicGo 响应超时，请检查 PicGo 的上传状态。"));
      if (length > RESPONSE_LIMIT) throw error;
      throw new Error(t("PicGo 响应中断，请查看 PicGo 日志。"));
    }
    this.ensureActive(active);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error(t("PicGo 返回了无效结果，请查看 PicGo 日志。")); }
  }
  async check() {
    return this.serial(async active => {
      // Never probe /upload with an empty list: PicGo interprets it as clipboard upload.
      const reply = await this.request('heartbeat', {}, this.port(), active);
      if (reply?.success !== true || reply.result !== 'alive') throw new Error(t("PicGo 未返回有效心跳，请检查 Server 设置。"));
      return t("PicGo 连接正常。此检测没有上传图片。");
    });
  }
  async validateDocument(plan) {
    this.authorize(plan.documentPath);
    if (pathKey(await this.boundary(plan.documentPath)) !== pathKey(plan.root)) throw new Error(t("工作区已切换，请重新选择上传图片。"));
    if (this.port() !== plan.port) throw new Error(t("PicGo 端口已变化，请重新选择上传图片。"));
    const bytes = await boundedRead(plan.boundary, plan.documentPath, MAX_DOCUMENT_BYTES);
    if (digest(bytes) !== plan.revision) throw new Error(t("文稿已被其他程序修改，请处理外部变化后重新上传。"));
  }
  async prepare(input) {
    return this.serial(async active => {
      this.plan = null;
      if (!input || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || !Array.isArray(input.sources) || input.sources.length > 256 ||
        input.sources.some(source => typeof source !== 'string' || !source || /[\x00-\x1f]/.test(source)) ||
        input.sources.reduce((sum, source) => sum + Buffer.byteLength(source), 0) > MAX_DOCUMENT_BYTES * 2) throw new Error(t("无效的图片上传请求。"));
      const documentPath = this.authorize(validateAbsolutePath(input.documentPath));
      if (!isDocumentPath(documentPath)) throw new Error(t("先保存 Markdown 文稿，再上传文稿中的图片。"));
      const root = await this.boundary(documentPath), boundary = new WorkspaceStore(root);
      const plan = { id: randomUUID(), documentPath, revision: input.revision, root, boundary, port: this.port(),
        items: [], references: [], bytes: 0, remote: 0, expires: Date.now() + PLAN_LIFETIME };
      await this.validateDocument(plan);
      const unique = new Map();
      for (const source of new Set(input.sources)) {
        this.ensureActive(active);
        if (/^https?:\/\//i.test(source)) { plan.remote++; continue; }
        let item;
        if (/^data:/i.test(source)) item = embedded(source, this.limits.image);
        else {
          if (source.length > 32768) throw new Error(t("本地图片路径过长。"));
          const location = localSource(source, documentPath), checked = await boundary.existing(location.absolute);
          const bytes = await boundedRead(boundary, checked.path, this.limits.image), extension = path.extname(checked.path).toLowerCase();
          if (!imageType(bytes, extension)) throw new Error(t("图片格式或内容无效，请检查要上传的图片。"));
          item = { path: checked.path, extension, key: pathKey(checked.path), name: path.basename(checked.path, extension), hash: digest(bytes), size: bytes.length };
        }
        let index = unique.get(item.key);
        if (index === undefined) {
          item.hash ??= digest(item.bytes); item.size ??= item.bytes.length;
          plan.bytes += item.size;
          if (plan.items.length >= this.limits.images || plan.bytes > this.limits.bytes) throw new Error(t("一次最多上传 32 张不同图片，总大小不超过 80 MiB。"));
          index = plan.items.length; plan.items.push(item); unique.set(item.key, index);
        }
        plan.references.push({ source, index });
      }
      await this.validateDocument(plan); this.ensureActive(active); this.plan = plan;
      return { id: plan.id, count: plan.items.length, bytes: plan.bytes, remote: plan.remote, names: plan.items.map(item => item.name + item.extension) };
    });
  }
  async uploadPrepared(id) {
    return this.serial(async active => {
      const plan = this.plan;
      if (typeof id !== 'string' || !plan || id !== plan.id) throw new Error(t("图片上传预览已失效，请重新打开。"));
      this.plan = null;
      if (Date.now() > plan.expires) throw new Error(t("图片上传预览已过期，请重新打开。"));
      await this.validateDocument(plan);
      const images = [];
      for (const item of plan.items) {
        this.ensureActive(active);
        const bytes = item.bytes || await boundedRead(plan.boundary, item.path, this.limits.image);
        if (digest(bytes) !== item.hash) throw new Error(t("图片在预览后已变化，请重新选择上传图片。"));
        images.push({ bytes, name: item.name, extension: item.extension });
      }
      if (!images.length) return [];
      const urls = await this.uploadBatch(images, plan.port, active, () => this.validateDocument(plan));
      await this.validateDocument(plan);
      for (const item of plan.items) {
        this.ensureActive(active);
        if (item.path && digest(await boundedRead(plan.boundary, item.path, this.limits.image)) !== item.hash) throw new Error(t("图片在上传期间已变化，未更新图片引用，请重新选择上传。"));
      }
      this.ensureActive(active);
      return plan.references.map(reference => ({ source: reference.source, url: urls[reference.index] }));
    });
  }
  async uploadImages(input) {
    return this.serial(async active => {
      if (!Array.isArray(input) || !input.length || input.length > this.limits.images) throw new Error(t("一次可上传 1–32 张图片。"));
      const port = this.port(); let total = 0;
      const images = input.map(image => {
        if (!(image?.bytes instanceof Uint8Array) || !image.bytes.byteLength || image.bytes.byteLength > this.limits.image ||
          typeof image.name !== 'string' || !image.name || image.name.length > 1024 || /[\x00-\x1f]/.test(image.name)) throw new Error(t("每张图片需为支持格式，且不超过 20 MiB。"));
        total += image.bytes.byteLength;
        if (total > this.limits.bytes) throw new Error(t("每批上传图片不超过 80 MiB。"));
        const name = path.basename(image.name.replace(/\\/g, '/')), extension = path.extname(name).toLowerCase(), bytes = Buffer.from(image.bytes);
        if (!imageType(bytes, extension)) throw new Error(t("图片格式或内容无效，请检查要上传的图片。"));
        return { name: path.basename(name, extension), extension, bytes };
      });
      return this.uploadBatch(images, port, active);
    });
  }
  async uploadBatch(images, port, active, beforeSend = async () => {}) {
    if (!images.length) throw new Error(t("没有可以上传的图片。"));
    this.ensureActive(active);
    await fs.mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await fs.lstat(this.tempRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(t("图片上传临时目录必须是本地目录。"));
    const root = await fs.realpath(this.tempRoot), directory = await fs.mkdtemp(path.join(root, 'meki-picgo-'));
    const directoryInfo = await fs.lstat(directory), files = [];
    const verifyDirectory = async () => {
      const currentRoot = await fs.lstat(this.tempRoot), currentDirectory = await fs.lstat(directory);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !sameFile(currentRoot, rootInfo) || pathKey(await fs.realpath(this.tempRoot)) !== pathKey(root) ||
        pathKey(path.dirname(directory)) !== pathKey(root) || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() ||
        !sameFile(currentDirectory, directoryInfo) || pathKey(await fs.realpath(directory)) !== pathKey(directory)) throw new Error(t("图片上传临时目录已变化，已停止上传。"));
    };
    try {
      for (const image of images) {
        this.ensureActive(active); await verifyDirectory();
        const stem = image.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 48) || 'image';
        const file = path.join(directory, `${stem}-${randomUUID()}${image.extension}`);
        const handle = await fs.open(file, 'wx', 0o600);
        try { files.push({ path: file, stat: await handle.stat() }); await handle.writeFile(image.bytes); await handle.sync(); }
        finally { await handle.close(); }
      }
      await beforeSend(); this.ensureActive(active); await verifyDirectory();
      if (this.port() !== port) throw new Error(t("PicGo 端口已变化，请重新上传。"));
      const boundary = new WorkspaceStore(root);
      for (const [index, file] of files.entries()) {
        const stat = await fs.lstat(file.path);
        if (!stat.isFile() || stat.isSymbolicLink() || !sameFile(stat, file.stat) ||
          digest(await boundedRead(boundary, file.path, this.limits.image)) !== digest(images[index].bytes)) throw new Error(t("图片上传临时副本已变化，已停止上传。"));
      }
      await verifyDirectory(); this.ensureActive(active);
      const response = await this.request('upload', { list: files.map(file => file.path) }, port, active);
      if (response?.success !== true || !Array.isArray(response.result) || response.result.length !== images.length) throw new Error(t("PicGo 未返回完整的上传结果，请检查图床配置和上传日志。"));
      const urls = response.result.map(checkedUrl); this.ensureActive(active);
      return urls;
    } finally {
      // No recursive deletion: only unlink this request's still-owned regular files.
      try {
        await verifyDirectory();
        for (const file of files) {
          try {
            const stat = await fs.lstat(file.path);
            if (stat.isFile() && !stat.isSymbolicLink() && sameFile(stat, file.stat)) await fs.unlink(file.path);
          } catch { /* Preserve any replaced or unavailable path. */ }
        }
        await fs.rmdir(directory).catch(() => {});
      } catch { /* A changed temp directory is left untouched. */ }
    }
  }
}

module.exports = { ImageHosting };

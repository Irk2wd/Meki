'use strict';
const { t } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { randomUUID } = require('node:crypto');
const { WorkspaceStore, allowedName } = require('./workspace-store.cjs');
const { resolveImageDestination, ensureImageDestination, rollbackImageDirectories } = require('./image-destination.cjs');
const { downloadImage } = require('./image-download.cjs');
const { validateAbsolutePath, isDocumentPath, pathKey, isWithin, digest, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, imageType, encodeRelativePath } = require('./file-store.cjs');

const MAX_IMAGES = 32;
const MAX_BATCH_BYTES = 80 * 1024 * 1024;
const PLAN_LIFETIME = 5 * 60 * 1000;
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/svg+xml': '.svg' };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };

async function boundedRead(boundary, filePath, limit) {
  const checked = await boundary.existing(filePath);
  if (!checked.stat.isFile() || checked.stat.size > limit) throw new Error(t("图片必须是普通文件，且每张不超过 20 MiB。"));
  const handle = await fs.open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!sameFile(before, checked.stat) || before.size > limit) throw new Error(t("文件在读取前已变化，请重新整理。"));
    const buffer = Buffer.alloc(before.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const chunk = await handle.read(buffer, read, buffer.length - read, read);
      if (!chunk.bytesRead) break;
      read += chunk.bytesRead;
    }
    const after = await handle.stat();
    const current = await boundary.existing(filePath);
    if (read !== before.size || !sameFile(after, current.stat) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(t("文件在读取时已变化，请重新整理。"));
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}

function embedded(source, limit) {
  const split = source.search(/[?#]/), suffix = split < 0 ? '' : source.slice(split);
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(split < 0 ? source : source.slice(0, split));
  if (!match || !EXTENSIONS[match[1].toLowerCase()] || match[2].length % 4 === 1 || match[2].length > Math.ceil(limit / 3) * 4) throw new Error(t("嵌入图片需使用支持格式的 base64 data URL，每张不超过 20 MiB。"));
  const bytes = Buffer.from(match[2], 'base64'), extension = EXTENSIONS[match[1].toLowerCase()];
  if (bytes.length > limit || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '') || !imageType(bytes, extension)) throw new Error(t("嵌入图片的格式或内容无效。"));
  return { bytes, extension, key: `data:${digest(bytes)}:${extension}`, name: 'image', suffix };
}

function localSource(source, documentPath) {
  const split = source.search(/[?#]/), suffix = split < 0 ? '' : source.slice(split), location = split < 0 ? source : source.slice(0, split);
  if (!location || /^[\\/]{2}/.test(location) || (/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^file:/i.test(location) && !/^[a-z]:[\\/]/i.test(location))) throw new Error(t("只整理工作区内的本地图片和嵌入图片。"));
  let absolute;
  try { absolute = /^file:/i.test(location) ? fileURLToPath(location) : path.resolve(path.dirname(documentPath), decodeURIComponent(location)); }
  catch { throw new Error(t("本地图片路径无法解析。")); }
  if (/^\\\\/.test(absolute)) throw new Error(t("不读取网络共享图片。"));
  return { absolute: validateAbsolutePath(absolute), suffix };
}

class AttachmentStore {
  // authorize is supplied by main, never by a renderer. Hooks are only injected by unit tests.
  constructor({ authorize, boundary, settings = () => ({}), workspace = () => null, download = downloadImage, hooks = {}, limits = {} }) {
    this.authorize = authorize; this.boundary = boundary; this.hooks = hooks;
    this.settings = settings; this.workspace = workspace; this.download = download; this.downloadAbort = null;
    this.limits = { images: MAX_IMAGES, bytes: MAX_BATCH_BYTES, image: MAX_IMAGE_BYTES, ...limits };
    this.plan = null; this.running = false;
  }

  async serial(action) {
    if (this.running) throw new Error(t("附件操作正在进行，请稍后再试。"));
    this.running = true;
    try { return await action(); } finally { this.running = false; }
  }
  async validateDocument(plan) {
    this.authorize(plan.documentPath);
    if (pathKey(await this.boundary(plan.documentPath)) !== pathKey(plan.root)) throw new Error(t("工作区已切换，请重新整理图片。"));
    const bytes = await boundedRead(plan.boundary, plan.documentPath, MAX_DOCUMENT_BYTES);
    if (digest(bytes) !== plan.revision) throw new Error(t("文稿已被其他程序修改，请处理外部变化后重新整理图片。"));
  }
  get(id) {
    if (typeof id !== 'string' || !this.plan || this.plan.id !== id) throw new Error(t("附件预览已失效，请重新打开整理对话框。"));
    return this.plan;
  }
  // A crashed renderer may already have put copied paths in its recovery snapshot.
  // Drop the capability, but never infer that its copies are safe to delete.
  cancel() { this.downloadAbort?.abort(); }
  abandon() { this.cancel(); this.plan = null; }
  async prepare(input) {
    return this.serial(async () => {
      this.downloadAbort = new AbortController();
      if (input?.download !== undefined && typeof input.download !== 'boolean') throw new Error(t("无效的图片下载选项。"));
      if (input?.name !== undefined) allowedName(input.name);
      if (!input || typeof input !== 'object' || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || !Array.isArray(input.sources) || input.sources.length > 256 || input.sources.some(source => typeof source !== 'string' || !source || /[\x00-\x1f]/.test(source)) || input.sources.reduce((n, source) => n + Buffer.byteLength(source), 0) > MAX_DOCUMENT_BYTES * 2) throw new TypeError(t("无效的附件整理请求。"));
      if (this.plan?.state === 'copied') throw new Error(t("上次附件整理尚未完成。"));
      const documentPath = this.authorize(validateAbsolutePath(input.documentPath));
      if (!isDocumentPath(documentPath)) throw new Error(t("先保存 Markdown 文稿，再整理图片。"));
      const root = await this.boundary(documentPath), boundary = new WorkspaceStore(root);
      const settings = this.settings(), destination = await resolveImageDestination({ documentPath, workspaceRoot: this.workspace(), boundaryRoot: root, ...(input.destination || { base: settings.imageDirectoryBase, directory: settings.imageDirectory }) });
      const target = destination.target;
      const plan = { id: randomUUID(), documentPath, revision: input.revision, root, boundary, target, destination, requestedName: input.name, items: [], references: [], created: [], createdDirectories: [], bytes: 0, remote: 0, state: 'prepared', expires: Date.now() + PLAN_LIFETIME };
      await this.validateDocument(plan);
      const targetInfo = await fs.lstat(target).catch(missing);
      if (targetInfo && !(await boundary.existing(target)).stat.isDirectory()) throw new Error(t("附件目标不是文件夹。"));
      const unique = new Map();
      for (const source of new Set(input.sources)) {
        let item, suffix;
        if (/^https?:\/\//i.test(source)) {
          if (!input.download) { plan.remote++; continue; }
          const fetched = await this.download(source, { signal: this.downloadAbort.signal, maxBytes: Math.min(this.limits.image, this.limits.bytes - plan.bytes), validateImage: imageType });
          item = { bytes: fetched.bytes, extension: fetched.extension, key: source, name: path.basename(fetched.name, fetched.extension) }; suffix = '';
        }
        else if (/^data:/i.test(source)) { item = embedded(source, this.limits.image); suffix = item.suffix; }
        else {
          if (source.length > 32768) throw new Error(t("本地图片路径过长。"));
          const location = localSource(source, documentPath);
          const checked = await boundary.existing(location.absolute);
          const bytes = await boundedRead(boundary, checked.path, this.limits.image);
          const extension = path.extname(checked.path).toLowerCase();
          if (!imageType(bytes, extension)) throw new Error(t("不支持的图片或图片内容无效：{0}", path.basename(checked.path)));
          item = { path: checked.path, extension, key: pathKey(checked.path), name: path.basename(checked.path, extension), hash: digest(bytes), size: bytes.length, reuse: !input.destination && !input.name && isWithin(checked.path, target) };
          suffix = location.suffix;
        }
        let index = unique.get(item.key);
        if (index === undefined) {
          item.hash ??= digest(item.bytes); item.size ??= item.bytes.length;
          plan.bytes += item.size;
          if (plan.items.length >= this.limits.images || plan.bytes > this.limits.bytes) throw new Error(t("一次最多整理 32 张不同图片，总大小不超过 80 MiB。"));
          index = plan.items.length; plan.items.push(item); unique.set(item.key, index);
        }
        plan.references.push({ source, index, suffix });
      }
      if (input.name && plan.items.length !== 1) throw new Error(t("自定义图片名只适用于单张图片。"));
      if (input.name && path.extname(input.name) && path.extname(input.name).toLowerCase() !== plan.items[0].extension) throw new Error(t("图片副本的扩展名需与原图格式一致。"));
      await this.validateDocument(plan);
      this.downloadAbort.signal.throwIfAborted();
      this.plan = plan;
      return { id: plan.id, target, count: plan.items.filter(item => !item.reuse).length, reused: plan.items.filter(item => item.reuse).length, bytes: plan.bytes, remote: plan.remote };
    });
  }
  async commit(id) {
    return this.serial(async () => {
      const plan = this.get(id);
      if (plan.state !== 'prepared' || Date.now() > plan.expires) throw new Error(t("附件预览已失效，请重新整理。"));
      try {
        await this.validateDocument(plan);
        const buffers = [];
        for (const item of plan.items) {
          const bytes = item.bytes || await boundedRead(plan.boundary, item.path, this.limits.image);
          if (digest(bytes) !== item.hash) throw new Error(t("图片在预览后已变化，请重新整理。"));
          buffers.push(bytes);
        }
        if (plan.items.some(item => !item.reuse)) {
          const ready = await ensureImageDestination(plan.destination); plan.createdDirectories = ready.created;
        }
        for (const [index, item] of plan.items.entries()) {
          if (item.reuse) { item.output = item.path; continue; }
          await plan.boundary.existing(plan.target);
          const stem = item.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 48) || 'image';
          const name = plan.requestedName ? (path.extname(plan.requestedName) ? plan.requestedName : plan.requestedName + item.extension) : `${stem}-${randomUUID()}${item.extension}`;
          const output = path.join(plan.target, name);
          await this.hooks.beforeCreate?.(index, output);
          const handle = await fs.open(output, 'wx', 0o600);
          const record = { path: output, stat: await handle.stat(), hash: item.hash };
          plan.created.push(record);
          let written = 0;
          try {
            while (written < buffers[index].length) {
              const result = await handle.write(buffers[index], written, buffers[index].length - written, written);
              if (!result.bytesWritten) throw new Error(t("图片未能完整写入磁盘。"));
              written += result.bytesWritten;
            }
            await handle.sync();
          }
          catch (error) { record.hash = digest(buffers[index].subarray(0, written)); throw error; }
          finally { await handle.close(); }
          const checked = await plan.boundary.existing(output);
          if (!sameFile(checked.stat, record.stat)) throw new Error(t("附件目标在复制时已变化。"));
          item.output = output;
          await this.hooks.afterCopy?.(index, output);
        }
        await this.validateDocument(plan);
        plan.state = 'copied';
        return plan.references.map(ref => ({ source: ref.source, relativePath: encodeRelativePath(path.relative(path.dirname(plan.documentPath), plan.items[ref.index].output)) + ref.suffix }));
      } catch (error) {
        const retained = await this.rollback(plan); this.plan = null;
        if (retained) throw Object.assign(new Error(t("{0} 部分新副本或目录已被外部修改，已保留，请检查附件目录。", error.message)), { code: error.code });
        throw error;
      }
    });
  }
  async rollback(plan) {
    let retained = false;
    for (const record of [...plan.created].reverse()) {
      try {
        const entry = await plan.boundary.existing(record.path);
        if (!sameFile(entry.stat, record.stat)) { retained = true; continue; }
        if (digest(await boundedRead(plan.boundary, record.path, this.limits.image)) !== record.hash) { retained = true; continue; }
        await fs.unlink(record.path);
      } catch (error) { if (error.code !== 'ENOENT') retained = true; }
    }
    retained = await rollbackImageDirectories(plan.createdDirectories, plan.root) || retained;
    return retained;
  }
  async finish(id, keep) {
    return this.serial(async () => {
      if (typeof keep !== 'boolean') throw new TypeError(t("无效的附件确认。"));
      const plan = this.get(id);
      if (keep && plan.state !== 'copied') throw new Error(t("附件尚未复制。"));
      const retained = !keep && await this.rollback(plan); this.plan = null;
      if (retained) throw new Error(t("部分新副本已被外部修改，已保留，请检查附件目录。"));
    });
  }
}

module.exports = { AttachmentStore, MAX_IMAGES, MAX_BATCH_BYTES, boundedRead, embedded, localSource };

'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const { atomicWrite, readBytes, digest, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');
const { MAX_TABS, MAX_SESSION_BYTES } = require('./lifecycle-store.cjs');

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_WINDOWS = 8, MAX_BYTES = 128 * 1024 * 1024, MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const blobName = /^[a-f0-9]{64}\.gz$/;

// Bodies are immutable; a small atomic catalog switches all windows to one complete state.
class RecoveryStore {
  constructor(userData) {
    this.root = path.join(userData, 'recovery-v2');
    this.filename = path.join(this.root, 'windows.json');
    this.documents = new Map(); this.verified = new Set(); this.catalog = null; this.revision = null; this.importedLegacy = null;
  }
  async init() { await fs.mkdir(this.root, { recursive: true }); await this.checkRoot(); }
  async checkRoot() {
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(t("恢复记录目录必须是普通本地目录。"));
  }
  async checkedFile(filename) {
    await this.checkRoot();
    const stat = await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error(t("恢复记录必须是普通文件。"));
    return stat;
  }
  blob(ref) {
    if (!ref || typeof ref.hash !== 'string' || !blobName.test(`${ref.hash}.gz`) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_DOCUMENT_BYTES) throw new Error(t("恢复内容引用无效。"));
    return path.join(this.root, `${ref.hash}.gz`);
  }
  async readContent(ref) {
    const filename = this.blob(ref);
    if (!await this.checkedFile(filename)) throw new Error(t("恢复内容文件缺失。"));
    // JSON preserves every JS string, including partial surrogate pairs during composition.
    const maximum = ref.bytes * 6 + 2;
    const { bytes } = await readBytes(filename, maximum + 128 * 1024);
    const decoded = await decompress(bytes, { maxOutputLength: maximum });
    if (digest(decoded) !== ref.hash) throw new Error(t("恢复内容校验失败。"));
    const content = JSON.parse(decoded.toString('utf8'));
    if (typeof content !== 'string' || Buffer.byteLength(content) !== ref.bytes) throw new Error(t("恢复内容校验失败。"));
    this.verified.add(ref.hash); return content;
  }
  async read() {
    if (!await this.checkedFile(this.filename)) return null;
    const catalog = (await readBytes(this.filename, MAX_CATALOG_BYTES)).bytes.toString('utf8'), data = JSON.parse(catalog);
    if (data.version !== 2 || !Array.isArray(data.windows) || data.windows.length > MAX_WINDOWS || data.revision !== digest(Buffer.from(JSON.stringify({ importedLegacy: data.importedLegacy || null, windows: data.windows }))) ||
        (data.importedLegacy != null && !/^[a-f0-9]{64}$/.test(data.importedLegacy))) throw new Error(t("无法识别恢复记录格式。"));
    let total = 0;
    // Bound all declared bodies before decompressing any of them.
    for (const record of data.windows) {
      if (record?.session === null) continue;
      if (!Array.isArray(record?.session?.documents) || record.session.documents.length > MAX_TABS) throw new Error(t("无法识别恢复记录格式。"));
      let windowBytes = 0;
      for (const doc of record.session.documents) {
        this.blob(doc?.contentRef); windowBytes += doc.contentRef.bytes;
      }
      total += windowBytes;
      if (windowBytes > MAX_SESSION_BYTES || total > MAX_BYTES) throw new Error(t("恢复记录内容超过容量限制。"));
    }
    const documents = new Map(), bodies = new Map(), records = [];
    for (const record of data.windows) {
      if (!record.session) { records.push(record); continue; }
      const restored = [];
      for (const doc of record.session.documents) {
        const { contentRef, ...metadata } = doc;
        if (!bodies.has(contentRef.hash)) bodies.set(contentRef.hash, await this.readContent(contentRef));
        const content = bodies.get(contentRef.hash);
        if (Buffer.byteLength(content) !== contentRef.bytes) throw new Error(t("恢复内容校验失败。"));
        documents.set(doc.id, { content, ref: contentRef }); restored.push({ ...metadata, content });
      }
      records.push({ ...record, session: { ...record.session, documents: restored } });
    }
    this.documents = documents; this.catalog = catalog; this.revision = data.revision; this.importedLegacy = data.importedLegacy || null;
    return records;
  }
  async reference(id, content) {
    const previous = this.documents.get(id);
    if (previous?.content === content && await this.checkedFile(this.blob(previous.ref))) return previous.ref;
    const bytes = Buffer.from(JSON.stringify(content)), ref = { hash: digest(bytes), bytes: Buffer.byteLength(content) };
    const filename = this.blob(ref);
    if (await this.checkedFile(filename)) {
      if (!this.verified.has(ref.hash)) await this.readContent(ref);
    } else {
      await atomicWrite(filename, await compress(bytes, { level: 1 })); this.verified.add(ref.hash);
    }
    return ref;
  }
  async prune(documents) {
    const kept = new Set([...documents.values()].map(item => `${item.ref.hash}.gz`));
    for (const file of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!file.isFile() || !blobName.test(file.name) || kept.has(file.name)) continue;
      const filename = path.join(this.root, file.name);
      if (await this.checkedFile(filename)) await fs.unlink(filename);
      this.verified.delete(file.name.slice(0, -3));
    }
  }
  async write(records) {
    const documents = new Map(), encoded = [];
    try {
      const exists = await this.checkedFile(this.filename);
      for (const record of records) {
        if (!record.session) { encoded.push(record); continue; }
        const saved = [];
        for (const doc of record.session.documents) {
          const { content, ...metadata } = doc, ref = await this.reference(doc.id, content);
          documents.set(doc.id, { content, ref }); saved.push({ ...metadata, contentRef: ref });
        }
        encoded.push({ ...record, session: { ...record.session, documents: saved } });
      }
      const state = { importedLegacy: this.importedLegacy, windows: encoded }, revision = digest(Buffer.from(JSON.stringify(state)));
      const catalog = JSON.stringify({ version: 2, revision, ...state });
      if (Buffer.byteLength(catalog) > MAX_CATALOG_BYTES) throw new Error(t("恢复记录索引超过容量限制。"));
      if (!exists || catalog !== this.catalog) await atomicWrite(this.filename, Buffer.from(catalog));
      this.documents = documents; this.catalog = catalog; this.revision = revision;
    } catch (error) {
      await this.prune(this.documents).catch(() => {}); throw error;
    }
    // The catalog is committed. Cleanup failure must never roll the renderer back.
    await this.prune(documents).catch(error => console.warn('Meki retained an obsolete recovery body:', error.message));
  }
  async backup() {
    await this.checkRoot();
    // Preserve the entire broken catalog and its bodies together, including unreadable references.
    await fs.rename(this.root, path.join(path.dirname(this.root), `recovery-corrupt-${randomUUID()}`));
    this.documents.clear(); this.verified.clear(); this.catalog = null; this.revision = null;
    await this.init();
  }
}
module.exports = { RecoveryStore, MAX_WINDOWS, MAX_BYTES };

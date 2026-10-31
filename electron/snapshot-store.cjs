'use strict';
const { t } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateDocument, validateAbsolutePath, pathKey, isWithin, atomicWrite, readBytes, digest, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');

const LIMITS = Object.freeze({ count: 20, documentBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, documents: 128 });
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function validateTarget(value) {
  if (!value || typeof value.tabId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.tabId)) throw new TypeError(t("无效的文稿标签。"));
  return { path: value.path === null ? null : validateAbsolutePath(value.path), tabId: value.tabId };
}
const owner = value => value.path ? `file:${pathKey(value.path)}` : `draft:${value.tabId}`;
function labelText(value = '') {
  if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError(t("快照名称最多 80 个字符，不能包含换行。"));
  return value.trim();
}

// Kept separate from pre-save file history and session recovery for update rollback compatibility.
class SnapshotStore {
  constructor(store, limits = {}) {
    this.store = store;
    this.root = path.join(store.userData, 'snapshots-v1');
    this.indexPath = path.join(this.root, 'index.json');
    this.entries = [];
    this.limits = { ...LIMITS, ...limits };
    this.error = null;
  }
  async checkRoot() {
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(t("快照目录不能是链接。"));
  }
  async checkedFile(name) {
    await this.checkRoot();
    const filename = path.join(this.root, name);
    const stat = await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error(t("快照文件不能是链接或特殊文件。"));
    return filename;
  }
  async init() {
    try {
      await fs.mkdir(this.root, { recursive: true }); await this.checkRoot();
      const file = await this.checkedFile('index.json');
      const stat = await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (stat) {
        if (stat.size > MAX_INDEX_BYTES) throw new Error(t("快照索引过大。"));
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > LIMITS.count * LIMITS.documents) throw new Error(t("快照索引格式无效。"));
        const ids = new Set();
        this.entries = data.entries.map(value => {
          const target = validateTarget(value);
          if (!uuid(value.id) || ids.has(value.id) || typeof value.name !== 'string' || value.name.length > 512 ||
              !['manual', 'auto', 'restore'].includes(value.kind) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
              !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_DOCUMENT_BYTES ||
              typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error(t("快照记录无效。"));
          ids.add(value.id);
          return { ...target, id: value.id, name: value.name, label: labelText(value.label), kind: value.kind, createdAt: value.createdAt, size: value.size, revision: value.revision };
        }).sort((a, b) => b.createdAt - a.createdAt);
        if (this.prune(this.entries).length !== this.entries.length) throw new Error(t("快照索引超出容量限制。"));
      }
      // Only unreferenced UUID blobs owned by this store can be cleaned up.
      const kept = new Set(this.entries.map(item => `${item.id}.bin`));
      for (const item of await fs.readdir(this.root, { withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith('.bin') && uuid(item.name.slice(0, -4)) && !kept.has(item.name)) await this.removeBlob(item.name.slice(0, -4));
      }
    } catch (error) { this.entries = []; this.error = t("快照暂不可用，已保留原数据：{0}", error.message); console.warn(this.error); }
  }
  assertHealthy() { if (this.error) throw new Error(this.error); }
  prune(entries, protectedId) {
    const next = [...entries].sort((a, b) => b.createdAt - a.createdAt);
    const bytes = items => items.reduce((sum, item) => sum + item.size, 0);
    const removeOldest = candidates => {
      const item = [...candidates].reverse().find(item => item.kind !== 'manual' && item.id !== protectedId);
      if (!item) throw new Error(t("快照空间已满，请在快照窗口删除不再需要的手动快照。"));
      next.splice(next.indexOf(item), 1);
    };
    for (const key of new Set(next.map(owner))) {
      let group = next.filter(item => owner(item) === key);
      while (group.length > this.limits.count || bytes(group) > this.limits.documentBytes) {
        removeOldest(group); group = next.filter(item => owner(item) === key);
      }
    }
    while (bytes(next) > this.limits.totalBytes || new Set(next.map(owner)).size > this.limits.documents) removeOldest(next);
    return next;
  }
  async writeIndex(entries) {
    this.assertHealthy();
    const data = Buffer.from(JSON.stringify({ version: 1, entries }));
    if (data.length > MAX_INDEX_BYTES) throw new Error(t("快照索引已满，请删除部分旧快照。"));
    await atomicWrite(await this.checkedFile('index.json'), data);
    this.entries = entries;
  }
  async removeBlob(id) {
    try { await fs.unlink(await this.checkedFile(`${id}.bin`)); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('Meki retained an obsolete snapshot:', error.message); }
  }
  async commit(entries) {
    const removed = this.entries.filter(item => !entries.some(other => other.id === item.id));
    await this.writeIndex(entries);
    for (const item of removed) await this.removeBlob(item.id);
  }
  async create(input) {
    const doc = validateDocument(input), target = validateTarget(input);
    if (!['manual', 'auto', 'restore'].includes(input.kind)) throw new TypeError(t("无效的快照类型。"));
    const label = labelText(input.label), bytes = Buffer.from(doc.content), revision = digest(bytes);
    return this.store.locked('snapshots', async () => {
      this.assertHealthy();
      const latest = this.entries.find(item => owner(item) === owner(target));
      if (input.kind === 'auto' && latest?.revision === revision) return { ...latest };
      const entry = { ...target, id: randomUUID(), name: doc.name, label,
        kind: input.kind, createdAt: Math.max(Date.now(), (this.entries[0]?.createdAt || 0) + 1), size: bytes.length, revision };
      const next = this.prune([entry, ...this.entries], entry.id);
      const filename = await this.checkedFile(`${entry.id}.bin`);
      await atomicWrite(filename, bytes);
      try { await this.commit(next); }
      catch (error) { await this.removeBlob(entry.id); throw error; }
      return { ...entry };
    });
  }
  list(target) {
    this.assertHealthy();
    const key = target === undefined ? null : owner(validateTarget(target));
    return this.entries.filter(item => key === null || owner(item) === key).map(item => ({ ...item }));
  }
  async read(id) {
    return this.store.locked('snapshots', async () => {
      this.assertHealthy();
      if (!uuid(id)) throw new TypeError(t("无效的快照 ID。"));
      const snapshot = this.entries.find(item => item.id === id);
      if (!snapshot) throw new Error(t("此快照已不可用。"));
      const { bytes } = await readBytes(await this.checkedFile(`${id}.bin`));
      if (bytes.length !== snapshot.size || digest(bytes) !== snapshot.revision) throw new Error(t("快照校验失败，当前文稿未被修改。"));
      return { snapshot: { ...snapshot }, content: bytes.toString('utf8') };
    });
  }
  async delete(id) {
    return this.store.locked('snapshots', async () => {
      this.assertHealthy();
      if (!uuid(id) || !this.entries.some(item => item.id === id)) throw new Error(t("此快照已不可用。"));
      await this.commit(this.entries.filter(item => item.id !== id));
    });
  }
  async adopt(tabId, filePath) {
    const target = validateTarget({ tabId, path: filePath });
    return this.store.locked('snapshots', async () => {
      this.assertHealthy();
      if (!this.entries.some(item => item.path === null && item.tabId === tabId)) return;
      const entries = this.entries.map(item => item.path === null && item.tabId === tabId ? { ...item, path: target.path, name: path.basename(target.path) } : item);
      await this.commit(this.prune(entries));
    });
  }
  async remap(from, to) {
    if (!to) return; // A trashed document remains recoverable from the all-documents library.
    from = validateAbsolutePath(from); to = validateAbsolutePath(to);
    return this.store.locked('snapshots', async () => {
      this.assertHealthy();
      if (!this.entries.some(item => item.path && isWithin(item.path, from))) return;
      const entries = this.entries.map(item => {
        if (!item.path || !isWithin(item.path, from)) return item;
        const next = path.join(to, path.relative(from, item.path));
        return { ...item, path: next, name: path.basename(next) };
      });
      await this.commit(this.prune(entries));
    });
  }
}
module.exports = { SnapshotStore, validateTarget, LIMITS };

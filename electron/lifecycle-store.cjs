'use strict';
const { t } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateLayout, reconcileLayout } = require('./pane-layout.mjs');
const { validateDocument, validateAbsolutePath, pathKey, isWithin, atomicWrite, readBytes, decodeDocument, digest, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');

const MAX_TABS = 24;
const MAX_SESSION_BYTES = 48 * 1024 * 1024;
const MAX_VERSIONS = 20;
const MAX_DOCUMENT_HISTORY = 32 * 1024 * 1024;
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_DOCUMENTS = 128;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const blobPattern = /^[a-f0-9]{64}\/[a-f0-9-]{36}\.bin$/;

function validateSession(input) {
  if (!input || !Array.isArray(input.documents) || input.documents.length > MAX_TABS) throw new TypeError(t("会话最多保留 24 个文稿标签。"));
  const ids = new Set(), paths = new Set();
  let bytes = 0;
  const documents = input.documents.map(value => {
    const doc = validateDocument(value);
    if (!identifier(value.id) || ids.has(value.id) || typeof value.dirty !== 'boolean' || !['visual', 'source'].includes(value.mode) || ![null, 'external', 'history', 'recovered', 'attachments', 'error'].includes(value.paused)) throw new TypeError('Invalid session document.');
    ids.add(value.id);
    if (doc.path) { const key = pathKey(doc.path); if (paths.has(key)) throw new TypeError('A file cannot be opened in two tabs.'); paths.add(key); }
    bytes += Buffer.byteLength(doc.content, 'utf8');
    if (bytes > MAX_SESSION_BYTES) throw new TypeError(t("会话内容超过 48 MiB，请先保存并关闭部分文稿。"));
    return { ...doc, id: value.id, dirty: value.dirty, mode: value.mode, paused: value.paused };
  });
  if (input.activeId !== null && (!identifier(input.activeId) || !ids.has(input.activeId))) throw new TypeError('Invalid active session tab.');
  if (documents.length && input.activeId === null) throw new TypeError('An active session tab is required.');
  return { documents, activeId: input.activeId, ...(input.layout && documents.length ? { layout: validateLayout(input.layout, documents.map(doc => doc.id)) } : {}) };
}

class LifecycleStore {
  constructor(fileStore, limits = {}) {
    this.store = fileStore;
    this.sessionPath = path.join(fileStore.userData, 'session.json');
    this.historyRoot = path.join(fileStore.userData, 'versions');
    this.indexPath = path.join(this.historyRoot, 'index.json');
    this.session = null;
    this.history = [];
    // Smaller injected limits make pruning tests inexpensive; production always uses defaults.
    this.limits = { count: MAX_VERSIONS, documentBytes: MAX_DOCUMENT_HISTORY, bytes: MAX_HISTORY_BYTES, documents: MAX_HISTORY_DOCUMENTS, ...limits };
  }

  async init() {
    await fs.mkdir(this.historyRoot, { recursive: true });
    const rootInfo = await fs.lstat(this.historyRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(t("版本历史目录必须是普通本地目录。"));
    try {
      const value = JSON.parse((await readBytes(this.sessionPath, MAX_SESSION_BYTES * 6 + 256 * 1024)).bytes.toString('utf8'));
      if (value.version !== 1 || typeof value.cleanExit !== 'boolean') throw new Error('Invalid session format.');
      this.session = { ...validateSession(value), cleanExit: value.cleanExit };
    } catch (error) { if (error.code !== 'ENOENT') { this.sessionBackupPending = true; console.warn('Meki will back up its unreadable session before writing a replacement:', error.message); } }
    try {
      const value = JSON.parse((await readBytes(this.indexPath, 2 * 1024 * 1024)).bytes.toString('utf8'));
      if (!Array.isArray(value) || value.length > MAX_HISTORY_DOCUMENTS) throw new Error('Invalid history index.');
      const seen = new Set(); let total = 0;
      this.history = value.map(record => {
        const filePath = validateAbsolutePath(record.path), key = pathKey(filePath);
        if (seen.has(key) || !Array.isArray(record.versions) || record.versions.length > MAX_VERSIONS) throw new Error('Invalid history document.');
        seen.add(key); const ids = new Set(); let docBytes = 0;
        const versions = record.versions.map(version => {
          if (!identifier(version.id) || ids.has(version.id) || !blobPattern.test(version.blob) || !/^[a-f0-9]{64}$/.test(version.revision) || !Number.isFinite(version.createdAt) || version.createdAt <= 0 || !Number.isInteger(version.size) || version.size < 0 || version.size > MAX_DOCUMENT_BYTES) throw new Error('Invalid history version.');
          ids.add(version.id); docBytes += version.size; return { id: version.id, blob: version.blob, revision: version.revision, createdAt: version.createdAt, size: version.size };
        });
        total += docBytes;
        if (docBytes > MAX_DOCUMENT_HISTORY || total > MAX_HISTORY_BYTES) throw new Error('History exceeds storage limits.');
        return { path: filePath, versions };
      });
    } catch (error) { this.history = []; if (error.code !== 'ENOENT') { this.historyError = error; console.warn('Meki retained an unreadable history index:', error.message); } }
    if (!this.historyError) await this.removeOrphans();
    return this.session;
  }

  async saveSession(input, cleanExit = false) {
    if (typeof cleanExit !== 'boolean') throw new TypeError('Invalid session close state.');
    const session = validateSession(input);
    return this.store.locked('session', () => this.writeSession(session, cleanExit));
  }

  async writeSession(session, cleanExit = false) {
    if (this.sessionBackupPending) {
      // Never overwrite an unreadable recovery file until an exclusive, durable copy exists.
      const stat = await fs.lstat(this.sessionPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(t("会话文件不是普通文件，已保留原路径，不能覆盖。"));
      const backupPath = path.join(this.store.userData, `session-corrupt-${Date.now()}-${crypto.randomUUID()}.json`);
      try {
        await fs.copyFile(this.sessionPath, backupPath, fs.constants.COPYFILE_EXCL);
        const backup = await fs.open(backupPath, 'r+');
        try { await backup.sync(); } finally { await backup.close(); }
      } catch (error) { throw new Error(t("无法备份损坏的会话，原文件未被覆盖：{0}", error.message)); }
      this.sessionBackupPending = false;
    }
    const next = { ...session, cleanExit };
    await atomicWrite(this.sessionPath, Buffer.from(JSON.stringify({ ...next, version: 1 }), 'utf8'));
    this.session = next;
  }

  async markClean() {
    return this.store.locked('session', async () => {
      if (!this.session) return;
      const next = { ...this.session, cleanExit: true };
      await atomicWrite(this.sessionPath, Buffer.from(JSON.stringify({ ...next, version: 1 }), 'utf8'));
      this.session = next;
    });
  }

  async restore(reopen) {
    if (!this.session) return null;
    const recovered = !this.session.cleanExit && this.session.documents.some(doc => doc.dirty);
    const documents = [];
    for (const saved of this.session.documents) {
      if (saved.dirty && !this.session.cleanExit) {
        // Prime the file-format cache without replacing the unsaved recovery text.
        if (saved.path) await this.store.readDocument(saved.path).catch(() => {});
        documents.push({ ...saved, paused: ['history', 'attachments'].includes(saved.paused) ? saved.paused : 'recovered' });
      } else if (reopen && saved.path) {
        try { documents.push({ ...saved, ...await this.store.readDocument(saved.path), dirty: false, paused: null }); }
        catch { /* Missing clean documents remain in recents, not as misleading saved tabs. */ }
      }
    }
    return { documents, activeId: documents.some(doc => doc.id === this.session.activeId) ? this.session.activeId : documents[0]?.id || null, recovered,
      ...(this.session.layout && documents.length ? { layout: reconcileLayout(this.session.layout, documents.map(doc => doc.id), this.session.activeId) } : {}) };
  }

  assertSaveTarget(filePath, tabId) {
    if (tabId !== undefined && !identifier(tabId)) throw new TypeError('Invalid document tab.');
    if (!tabId) return;
    const owner = this.session?.documents.find(doc => doc.path && pathKey(doc.path) === pathKey(filePath) && doc.id !== tabId);
    if (owner) throw new Error(t("该文件已在另一个标签中打开，请切换到那个标签或选择其他保存位置。"));
  }

  async blobPath(relative, create = false) {
    if (!blobPattern.test(relative)) throw new Error('Invalid history storage key.');
    const directory = path.join(this.historyRoot, relative.split('/')[0]);
    if (create) await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    for (const target of [this.historyRoot, directory]) {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(t("版本历史目录已变化。"));
    }
    const filename = path.join(this.historyRoot, relative);
    const stat = await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Invalid history file.');
    return filename;
  }

  async record(filePath, bytes) {
    filePath = validateAbsolutePath(filePath);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DOCUMENT_BYTES) throw new TypeError('Invalid history content.');
    return this.store.locked('history', async () => {
      if (this.historyError) throw new Error(t("本地版本索引损坏，已保留原索引。请修复用户数据目录中的 versions/index.json 后保存。"));
      const key = pathKey(filePath), revision = digest(bytes);
      const previous = this.history.find(record => pathKey(record.path) === key);
      if (previous?.versions[0]?.revision === revision) return;
      const latestTime = Math.max(0, ...this.history.flatMap(record => record.versions.map(version => version.createdAt)));
      const version = { id: crypto.randomUUID(), createdAt: Math.max(Date.now(), latestTime + 1), size: bytes.length, revision };
      version.blob = `${digest(Buffer.from(key))}/${version.id}.bin`;
      await atomicWrite(await this.blobPath(version.blob, true), bytes);
      let records = [{ path: filePath, versions: [version, ...(previous?.versions || [])] }, ...this.history.filter(record => pathKey(record.path) !== key).map(record => ({ ...record, versions: [...record.versions] }))];
      const removed = [];
      for (const record of records) {
        while (record.versions.length > this.limits.count || record.versions.reduce((sum, item) => sum + item.size, 0) > this.limits.documentBytes) removed.push(record.versions.pop());
      }
      while (records.length > this.limits.documents || records.reduce((sum, record) => sum + record.versions.reduce((sum, item) => sum + item.size, 0), 0) > this.limits.bytes) {
        const oldest = records.flatMap(record => record.versions.map(item => ({ record, item }))).sort((a, b) => a.item.createdAt - b.item.createdAt)[0];
        if (!oldest) break;
        oldest.record.versions = oldest.record.versions.filter(item => item !== oldest.item); removed.push(oldest.item);
        records = records.filter(record => record.versions.length);
      }
      records = records.filter(record => record.versions.length);
      try { await this.writeIndex(records); }
      catch (error) { await this.removeBlob(version.blob); throw error; }
      for (const item of removed) await this.removeBlob(item.blob);
    });
  }

  async writeIndex(records) {
    if (this.historyError) throw new Error(t("本地版本索引损坏，已保留原索引，无法更改版本历史。"));
    await atomicWrite(this.indexPath, Buffer.from(JSON.stringify(records), 'utf8'));
    this.history = records;
  }

  async removeBlob(blob) {
    try { const filename = await this.blobPath(blob); await fs.unlink(filename); await fs.rmdir(path.dirname(filename)).catch(() => {}); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('Meki retained an obsolete history file:', error.message); }
  }

  async removeOrphans() {
    const referenced = new Set(this.history.flatMap(record => record.versions.map(version => version.blob)));
    for (const bucket of await fs.readdir(this.historyRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory() || bucket.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(bucket.name)) continue;
      for (const entry of await fs.readdir(path.join(this.historyRoot, bucket.name), { withFileTypes: true })) {
        const blob = `${bucket.name}/${entry.name}`;
        if (entry.isFile() && blobPattern.test(blob) && !referenced.has(blob)) await this.removeBlob(blob);
      }
    }
  }

  async remapSession(from, to) {
    return this.store.locked('session', async () => {
      if (!this.session) return;
      const updated = { ...this.session, documents: this.session.documents.map(doc => {
        if (!doc.path || !isWithin(doc.path, from)) return doc;
        const next = to ? path.join(to, path.relative(from, doc.path)) : null;
        return { ...doc, path: next, name: next ? path.basename(next) : doc.name, revision: next ? doc.revision : null,
          dirty: next ? doc.dirty : true, paused: next ? doc.paused : 'external' };
      }) };
      await this.writeSession(validateSession(updated));
    });
  }

  list(filePath) {
    const record = this.history.find(record => pathKey(record.path) === pathKey(filePath));
    return (record?.versions || []).map(({ blob, ...version }) => version);
  }

  async read(filePath, id) {
    if (!identifier(id)) throw new TypeError('Invalid version ID.');
    const record = this.history.find(record => pathKey(record.path) === pathKey(filePath));
    const version = record?.versions.find(version => version.id === id);
    if (!version) throw new Error(t("此历史版本已不可用。"));
    const { bytes } = await readBytes(await this.blobPath(version.blob));
    if (bytes.length !== version.size || digest(bytes) !== version.revision) throw new Error(t("历史版本校验失败，原文件未被修改。"));
    return { content: decodeDocument(bytes).content };
  }

  async clear(filePath) {
    return this.store.locked('history', async () => {
      const removed = this.history.find(record => pathKey(record.path) === pathKey(filePath));
      await this.writeIndex(this.history.filter(record => record !== removed));
      for (const item of removed?.versions || []) await this.removeBlob(item.blob);
    });
  }

  async remap(from, to) {
    if (!to) return; // Trashing a file does not destroy its local history.
    return this.store.locked('history', async () => {
      const records = this.history.map(record => isWithin(record.path, from) ? { ...record, path: path.join(to, path.relative(from, record.path)) } : record);
      // A path may have old history after a file was trashed and another file took its name.
      const merged = new Map();
      for (const record of records) {
        const key = pathKey(record.path), existing = merged.get(key);
        if (existing) existing.versions.push(...record.versions);
        else merged.set(key, { ...record, versions: [...record.versions] });
      }
      const removed = [];
      for (const record of merged.values()) {
        record.versions.sort((a, b) => b.createdAt - a.createdAt);
        while (record.versions.length > this.limits.count || record.versions.reduce((sum, item) => sum + item.size, 0) > this.limits.documentBytes) removed.push(record.versions.pop());
      }
      await this.writeIndex([...merged.values()]);
      for (const item of removed) await this.removeBlob(item.blob);
    });
  }
}

module.exports = { LifecycleStore, validateSession, MAX_TABS, MAX_SESSION_BYTES, MAX_VERSIONS, MAX_DOCUMENT_HISTORY, MAX_HISTORY_BYTES };

'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateSession, LifecycleStore } = require('./lifecycle-store.cjs');
const { validateAbsolutePath, pathKey, isWithin, atomicWrite, readBytes, digest } = require('./file-store.cjs');
const { RecoveryStore, MAX_WINDOWS, MAX_BYTES } = require('./recovery-store.cjs');

const { reconcileLayout } = require('./pane-layout.mjs');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
function validateWindows(value) {
  if (!Array.isArray(value) || value.length > MAX_WINDOWS) throw new Error(t("最多打开 8 个编辑窗口。"));
  const ids = new Set(), tabs = new Set(), paths = new Set(); let bytes = 0;
  return value.map(record => {
    if (!record || !validId(record.id) || ids.has(record.id)) throw new Error(t("无效的窗口记录。"));
    ids.add(record.id);
    const session = record.session === null ? null : { ...validateSession(record.session), cleanExit: record.session.cleanExit === true };
    for (const doc of session?.documents || []) {
      if (tabs.has(doc.id) || (doc.path && paths.has(pathKey(doc.path)))) throw new Error(t("文稿已在其他窗口打开，请切换到对应窗口。"));
      tabs.add(doc.id); if (doc.path) paths.add(pathKey(doc.path));
      bytes += Buffer.byteLength(doc.content);
    }
    if (bytes > MAX_BYTES) throw new Error(t("所有窗口的恢复内容超过 128 MiB，请先保存并关闭部分文稿。"));
    let bounds = null;
    if (record.bounds) {
      const { x, y, width, height, maximized } = record.bounds;
      if (![x, y, width, height].every(Number.isFinite) || width < 400 || height < 300 || width > 20000 || height > 20000 || Math.abs(x) > 100000 || Math.abs(y) > 100000 || typeof maximized !== 'boolean') throw new Error(t("无效的窗口尺寸。"));
      bounds = { x, y, width, height, maximized };
    }
    return { id: record.id, session, bounds, workspaceRoot: record.workspaceRoot ? validateAbsolutePath(record.workspaceRoot) : null };
  });
}

class WindowSessions {
  constructor(store, history) {
    this.store = store; this.history = history;
    this.recovery = new RecoveryStore(store.userData); this.filename = this.recovery.filename;
    this.legacyFilename = path.join(store.userData, 'windows-v1.json');
    this.records = []; this.corrupt = false; this.legacyCorrupt = false; this.warning = '';
  }
  async checkFile(filename = this.legacyFilename) {
    const stat = await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error(t("窗口会话文件不是普通文件，已保留原路径。"));
    return stat;
  }
  async init() {
    await this.recovery.init();
    await this.recovery.checkedFile(this.filename);
    const legacy = await this.checkFile();
    let restored = false;
    try {
      const records = await this.recovery.read();
      if (records) { this.records = validateWindows(records); restored = true; }
    } catch (error) {
      this.corrupt = true; this.warning = t("窗口恢复记录损坏，已保留原数据，并尝试恢复主窗口。");
    }
    if (legacy) {
      try {
        const bytes = (await readBytes(this.legacyFilename, MAX_BYTES * 6 + 1024 * 1024)).bytes, data = JSON.parse(bytes.toString('utf8'));
        if (data.version !== 1) throw new Error(t("无法识别窗口会话版本。"));
        // Our compatibility exports are marked. Older writers omit that marker;
        // import each distinct legacy state once, without relying on clock accuracy.
        const revision = digest(bytes), exported = typeof data.recoveryRevision === 'string' && /^[a-f0-9]{64}$/.test(data.recoveryRevision);
        if (!restored || (!exported && revision !== this.recovery.importedLegacy)) {
          this.records = validateWindows(data.windows); this.recovery.importedLegacy = revision;
        }
        restored = true;
      } catch (error) {
        this.legacyCorrupt = true;
        if (!restored) this.warning = t("窗口恢复记录损坏，已保留原数据，并尝试恢复主窗口。");
      }
    }
    if (!restored) {
      this.records = [{ id: 'main', session: this.history.session, bounds: null, workspaceRoot: this.store.metadata.workspaceRoot || null }];
    }
  }
  get(id) { const record = this.records.find(item => item.id === id); if (!record) throw new Error(t("此窗口已关闭。")); return record; }
  owner(filePath) { return this.records.find(record => record.session?.documents.some(doc => doc.path && pathKey(doc.path) === pathKey(filePath))); }
  async commit(input) {
    const records = validateWindows(input);
    if (this.corrupt) {
      await this.recovery.backup();
      this.corrupt = false;
    }
    await this.recovery.write(records);
    this.records = records;
  }
  async checkpoint() {
    // Older code needs a full copy only at a normal close/update, never on each edit.
    await this.checkFile();
    if (this.legacyCorrupt) {
      const backup = path.join(this.store.userData, `windows-corrupt-${randomUUID()}.json`);
      await fs.copyFile(this.legacyFilename, backup, fs.constants.COPYFILE_EXCL);
      const handle = await fs.open(backup, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      this.legacyCorrupt = false;
    }
    await atomicWrite(this.legacyFilename, Buffer.from(JSON.stringify({ version: 1, recoveryRevision: this.recovery.revision, windows: this.records })));
    const primary = this.records.find(record => record.id === 'main') || this.records[0];
    const session = primary?.session || { documents: [], activeId: null };
    await this.history.saveSession(session, session.cleanExit === true);
  }
  async change(action, checkpoint = false) {
    return this.store.locked('windows', async () => {
      await this.commit(await action(this.records));
      if (checkpoint) await this.checkpoint().catch(error => {
        // The current recovery catalog is durable even if an older-version export fails.
        this.warning = t("窗口会话已保存，但旧版兼容恢复副本未能更新。"); console.warn(this.warning, error.message);
      });
    });
  }
  async save(id, session) {
    session = { ...validateSession(session), cleanExit: false };
    await this.change(records => { this.get(id); return records.map(record => record.id === id ? { ...record, session } : record); });
  }
  async add({ id = randomUUID(), session = null, bounds = null, workspaceRoot = null } = {}) {
    await this.change(records => [...records, { id, session, bounds, workspaceRoot }]); return id;
  }
  async update(id, patch) { await this.change(records => { this.get(id); return records.map(record => record.id === id ? { ...record, ...patch } : record); }); }
  async remove(id) { await this.change(records => records.filter(record => record.id !== id)); }
  async clean(ids) {
    await this.change(records => records.map(record => ids.includes(record.id) && record.session ? { ...record, session: { ...record.session, cleanExit: true } } : record), true);
  }
  async transfer(from, to, tabId) {
    await this.change(records => {
      const source = this.get(from), target = this.get(to);
      const doc = source.session?.documents.find(doc => doc.id === tabId);
      if (!doc || target.session?.documents.length) throw new Error(t("无法移动此文稿，请重试。"));
      const remaining = source.session.documents.filter(item => item.id !== tabId);
      return records.map(record => record.id === from ? { ...record, session: { ...(source.session.layout ? { layout: reconcileLayout(source.session.layout, remaining.map(doc => doc.id), source.session.activeId) } : {}), documents: remaining, activeId: remaining.some(doc => doc.id === source.session.activeId) ? source.session.activeId : remaining[0]?.id || null, cleanExit: false } }
        : record.id === to ? { ...record, session: { documents: [{ ...doc }], activeId: tabId, cleanExit: false } } : record);
    });
  }
  async finishClose(staged, remove = []) {
    await this.change(records => records.filter(record => !remove.includes(record.id)).map(record => staged.has(record.id)
      ? { ...record, session: { ...staged.get(record.id), cleanExit: true } } : record), true);
  }
  async rollbackTransfer(from, to, originalLayout) {
    await this.change(records => {
      const source = this.get(from), target = this.get(to);
      const docs = [...(source.session?.documents || []), ...(target.session?.documents || [])];
      const activeId = target.session?.activeId || source.session?.activeId || null, layout = originalLayout || source.session?.layout;
      return records.filter(record => record.id !== to).map(record => record.id === from ? { ...record, session: { documents: docs, activeId, cleanExit: false,
        ...(layout ? { layout: reconcileLayout(layout, docs.map(doc => doc.id), activeId) } : {}) } } : record);
    });
  }
  async startup(reopen) {
    const records = [];
    for (const record of this.records) {
      const restored = await LifecycleStore.prototype.restore.call({ session: record.session, store: this.store }, reopen);
      if (restored?.documents.length || record.session === null) records.push({ ...record, session: restored ? { ...restored, cleanExit: false } : null });
    }
    if (!records.length) records.push({ id: 'main', session: null, bounds: this.records[0]?.bounds || null, workspaceRoot: this.records[0]?.workspaceRoot || null });
    await this.change(() => records);
    return records;
  }
  facade(id) {
    const manager = this;
    return {
      get session() { return manager.get(id).session; },
      restore: reopen => LifecycleStore.prototype.restore.call({ session: manager.get(id).session, store: manager.store }, reopen),
      saveSession: input => manager.save(id, input),
      markClean: () => manager.clean([id]),
      assertSaveTarget(file, tabId) {
        const other = manager.owner(file); if (other && other.id !== id) throw new Error(t("该文件已在另一个窗口打开，请切换到那个窗口。"));
        return LifecycleStore.prototype.assertSaveTarget.call({ session: manager.get(id).session }, file, tabId);
      },
      async remapSession(from, to) {
        const previous = manager.get(id).session; if (!previous) return;
        await manager.save(id, { ...previous, documents: previous.documents.map(doc => {
          if (!doc.path || !isWithin(doc.path, from)) return doc;
          const next = to ? path.join(to, path.relative(from, doc.path)) : null;
          return { ...doc, path: next, name: next ? path.basename(next) : doc.name, revision: next ? doc.revision : null, dirty: next ? doc.dirty : true, paused: next ? doc.paused : 'external' };
        }) });
      },
      ...Object.fromEntries(['record', 'list', 'read', 'clear', 'remap'].map(method => [method, (...args) => manager.history[method](...args)])),
    };
  }
}
module.exports = { WindowSessions, validateWindows, MAX_WINDOWS, MAX_BYTES };

'use strict';
const { t } = require('./i18n.mjs');
const { app, ipcMain, screen, Menu } = require('electron');
const { pathKey, isWithin, validateAbsolutePath } = require('./file-store.cjs');
const { createEditorWindow } = require('./editor-window.cjs');

class WindowManager {
  constructor({ store, sessions, snapshots, updates, reopen }) {
    Object.assign(this, { store, sessions, snapshots, updates, reopen });
    this.controllers = new Map(); this.handlers = new Map(); this.methods = new Set();
    this.claims = new Map(); this.readyWaiters = new Map(); this.closing = new Set(); this.decisions = new Map();
    this.quitting = false; this.quitAllowed = false; this.opening = false;
    this.stagedClose = new Map();
  }
  count() { return this.controllers.size; }
  controller(id) { const value = this.controllers.get(id); if (!value) throw new Error(t("编辑窗口已关闭。")); return value; }
  focused() { return [...this.controllers.values()].find(item => item.window?.isFocused()) || [...this.controllers.values()].at(-1); }
  register(id, method, action) {
    if (!this.handlers.has(id)) this.handlers.set(id, new Map());
    this.handlers.get(id).set(method, action);
    if (this.methods.has(method)) return;
    this.methods.add(method);
    ipcMain.handle(`meki:${method}`, (event, ...args) => {
      const owner = [...this.controllers.values()].find(item => item.isTrustedRenderer(event));
      const handler = owner && this.handlers.get(owner.id)?.get(method);
      if (!handler) throw new Error('This request did not come from the Meki editor.');
      return handler(...args);
    });
  }
  attach(id, controller) { this.controllers.set(id, controller); }
  ready(id) { this.readyWaiters.get(id)?.resolve(); }
  async open(id, options = {}) {
    if (this.readyWaiters.has(id)) throw new Error(t("此窗口正在打开，请稍候。"));
    let timer;
    const ready = new Promise((resolve, reject) => {
      this.readyWaiters.set(id, { resolve, reject });
      timer = setTimeout(() => reject(new Error(t("新窗口未能完成启动，文稿仍保留在原窗口。"))), 30000);
    });
    ready.catch(() => {});
    try {
      if (process.env.MEKI_TEST === '1' && process.env.MEKI_TEST_WINDOW_FAILURE === '1' && options.transferred) throw new Error(t("模拟新窗口启动失败，文稿仍在原窗口。"));
      const controller = await createEditorWindow({ store: this.store, lifecycle: this.sessions.facade(id), snapshots: this.snapshots, updates: this.updates, coordinator: this, id, ...options });
      await ready; this.refreshMenus(); return controller;
    } finally { clearTimeout(timer); this.readyWaiters.delete(id); }
  }
  refreshMenus() {
    if (!this.count()) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ label: 'Meki', submenu: [{ id: 'command-about', label: t("关于 Meki"), click: () => {
          void this.reopen().then(() => this.focused()?.sendCommand('about')).catch(error => console.error('Could not open About Meki:', error));
        } }, { role: 'quit', label: t("退出 Meki") }] }] : []),
        { label: t("文件"), submenu: [
          { label: t("重新打开窗口"), accelerator: require('./shortcuts.mjs').accelerator(require('./shortcuts.mjs').bindings(this.store.metadata.settings.shortcuts, process.platform)['new-window'], process.platform), click: () => { void this.reopen().catch(error => console.error('Could not reopen Meki:', error)); } },
          ...(process.platform === 'darwin' ? [] : [{ role: 'quit', label: t("退出") }]),
        ] },
      ]));
      return;
    }
    for (const controller of this.controllers.values()) controller.rebuildMenu();
  }
  focus(id, file) {
    const controller = this.controllers.get(id); if (!controller) return;
    if (file) {
      const tab = this.sessions.get(id).session?.documents.find(doc => doc.path && pathKey(doc.path) === pathKey(file));
      if (tab) controller.sendCommand('activate-tab', tab.id);
    }
    if (controller.window.isMinimized()) controller.window.restore();
    controller.window.show(); controller.window.focus();
  }
  windowMenu(active) {
    return [...this.controllers.values()].map((item, index) => ({ label: `${index + 1}. ${item.activeDocument.name}`, type: 'checkbox', checked: item.id === active, click: () => this.focus(item.id) }));
  }
  owner(file) { return this.sessions.owner(file)?.id || this.quitOriginal?.find(record => record.session?.documents.some(doc => doc.path && pathKey(doc.path) === pathKey(file)))?.id || this.claims.get(pathKey(file)); }
  claim(id, file) {
    const owner = this.owner(file);
    if (owner && owner !== id) {
      if (this.controllers.has(owner)) this.focus(owner, file);
      else void this.open(owner).then(() => this.focus(owner, file)).catch(error => this.controllers.get(id)?.sendCommand('window-notice', error.message));
      this.controller(id).sendCommand('window-notice', t("此文稿已在另一个窗口打开，已切换到对应窗口。"));
      return false;
    }
    this.claims.set(pathKey(file), id); return true;
  }
  releaseClaim(id, file) { file = validateAbsolutePath(file); if (this.claims.get(pathKey(file)) === id) this.claims.delete(pathKey(file)); }
  sessionSaved(id, session) { for (const doc of session.documents) if (doc.path) this.releaseClaim(id, doc.path); }
  async saveTarget(id, file, tabId, action) {
    const owner = this.owner(file);
    if (owner && owner !== id) throw new Error(t("该文件正在另一个窗口中编辑，请切换到那个窗口，或选择其他保存位置。"));
    this.claims.set(pathKey(file), id);
    try { return await action(); }
    catch (error) { this.releaseClaim(id, file); throw error; }
    finally { if (!tabId) this.releaseClaim(id, file); }
  }
  assertWorkspaceOperation(id, input) {
    if (this.quitting) throw new Error(t("正在处理退出确认，请完成后再操作文件。"));
    if (!['rename', 'move', 'trash'].includes(input?.action)) return;
    const from = validateAbsolutePath(input.path);
    for (const record of this.sessions.records) if (record.id !== id && record.session?.documents.some(doc => doc.path && isWithin(doc.path, from))) throw new Error(t("此文件或目录包含其他窗口正在编辑的文稿，请先关闭对应文稿，再移动、重命名或删除。"));
    for (const [file, owner] of this.claims) if (owner !== id && isWithin(file, from)) throw new Error(t("其他窗口正在打开或保存此路径，请稍后再试。"));
  }
  settingsChanged(source, patch) {
    const saved = Object.fromEntries(Object.keys(patch).map(key => [key, this.store.metadata.settings[key]]));
    for (const item of this.controllers.values()) if (item.id !== source) item.sendCommand('settings-changed', saved);
    this.refreshMenus();
  }
  async newWindow(source) {
    if (this.quitting || this.opening) throw new Error(t("正在处理窗口操作，请稍后再试。"));
    this.opening = true; let id;
    try {
      id = await this.sessions.add({ workspaceRoot: this.controllers.get(source)?.workspaceRoot || null });
      await this.open(id, { fresh: true }); this.focus(id); return id;
    } catch (error) { if (id) { this.controllers.get(id)?.destroy(); await this.sessions.remove(id); } throw error; }
    finally { this.opening = false; }
  }
  async detach(source, tabId) {
    if (this.quitting || this.opening) throw new Error(t("正在处理窗口操作，请稍后再试。"));
    const originalLayout = this.sessions.get(source).session?.layout;
    const doc = this.sessions.get(source).session?.documents.find(doc => doc.id === tabId);
    if (!doc) throw new Error(t("此文稿已经关闭，请重新选择。"));
    this.opening = true; let id, moved = false;
    try {
      id = await this.sessions.add({ workspaceRoot: this.controller(source).workspaceRoot });
      await this.sessions.transfer(source, id, tabId); moved = true;
      if (doc.path) this.releaseClaim(source, doc.path);
      await this.open(id, { initialSession: { ...this.sessions.get(id).session, recovered: false }, transferred: true });
      this.focus(id); return true;
    } catch (error) {
      if (id) {
        this.controllers.get(id)?.destroy();
        if (moved) await this.sessions.rollbackTransfer(source, id, originalLayout); else await this.sessions.remove(id);
      }
      throw error;
    } finally { this.opening = false; }
  }
  async tile(id) {
    if (this.count() < 2) await this.newWindow(id);
    const first = this.controller(id), second = [...this.controllers.values()].reverse().find(item => item !== first);
    const area = screen.getDisplayMatching(first.window.getBounds()).workArea;
    if (area.width < 960 || area.height < 420) throw new Error(t("当前屏幕空间不足以左右并排，请在较宽的显示器上使用。"));
    const width = Math.floor(area.width / 2);
    for (const [index, item] of [first, second].entries()) {
      item.window.setFullScreen(false); item.window.unmaximize(); item.window.restore();
      item.window.setBounds({ x: area.x + index * width, y: area.y, width: index ? area.width - width : width, height: area.height });
      item.window.show(); await item.persistWindowBounds();
    }
    this.focus(id);
  }
  requestClose(id) { if (this.quitting || this.closing.has(id)) return; this.closing.add(id); this.controller(id).sendCommand('close-request'); }
  cancelClose(id) { this.closing.delete(id); this.stagedClose.delete(id); this.decisions.get(id)?.decide(false); }
  stageClose(id, session) { this.sessions.get(id); this.stagedClose.set(id, session); }
  async approveClose(id) {
    const pending = this.decisions.get(id);
    if (pending) { pending.decide(true); return pending.finished; }
    if (this.quitting) return false;
    if (!this.stagedClose.has(id)) throw new Error(t("请先确认此窗口的未保存文稿。"));
    await this.sessions.finishClose(new Map([[id, this.stagedClose.get(id)]]), this.count() > 1 ? [id] : []);
    this.stagedClose.delete(id);
    setImmediate(() => this.controllers.get(id)?.close()); return true;
  }
  async quit() {
    if (this.quitting || this.opening) return;
    this.quitting = true;
    this.quitOriginal = this.sessions.records;
    const order = [...this.controllers.values()], approvals = [];
    try {
      for (const item of order) {
        let decide, finish;
        const decision = new Promise(resolve => { decide = resolve; }), finished = new Promise(resolve => { finish = resolve; });
        this.decisions.set(item.id, { decide, finished, finish }); approvals.push(item.id);
        this.focus(item.id); item.sendCommand('close-request');
        if (!await decision) return;
      }
      await this.sessions.finishClose(this.stagedClose);
      this.quitAllowed = true;
      for (const item of order) item.close();
      setImmediate(() => app.quit());
    } catch (error) { this.focused()?.sendCommand('window-notice', t("无法退出，文稿仍保留：{0}", error.message)); }
    finally {
      for (const id of approvals) this.decisions.get(id)?.finish(this.quitAllowed);
      this.decisions.clear(); this.closing.clear();
      this.stagedClose.clear();
      this.quitOriginal = null;
      if (!this.quitAllowed) this.quitting = false;
    }
  }
  allowQuit() { this.quitAllowed = true; }
  async finishUpdate(id) { if (this.stagedClose.has(id)) await this.sessions.finishClose(new Map([[id, this.stagedClose.get(id)]])); }
  rendererGone(id) { this.readyWaiters.get(id)?.reject(new Error(t("新窗口意外停止，原文稿已保留。"))); this.cancelClose(id); }
  closed(id) {
    this.rendererGone(id); this.controllers.delete(id); this.handlers.delete(id); this.closing.delete(id);
    for (const [file, owner] of this.claims) if (owner === id) this.claims.delete(file);
    this.refreshMenus();
  }
}
module.exports = { WindowManager };

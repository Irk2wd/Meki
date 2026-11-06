'use strict';
const { t, getLocale } = require('./i18n.mjs');

const { app, BrowserWindow, Menu, dialog, shell, screen, clipboard, session } = require('electron');
const bootstrap = globalThis[Symbol.for('meki.bootstrap')];
const { WorkspaceStore, documentStatus } = require('./workspace-store.cjs');
const { validateSession } = require('./lifecycle-store.cjs');
const { validateTarget } = require('./snapshot-store.cjs');
const { registerClipboardText } = require('./clipboard-text.cjs');
const { bindings, commandFor, eventBinding, defaultBinding, shortcutCatalog, shortcutIds, accelerator, validateBindings } = require('./shortcuts.mjs');
const { AttachmentStore } = require('./attachment-store.cjs');
const { ImageHosting } = require('./image-hosting.cjs');
const { createImageDownloader } = require('./image-download.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { readSelectedImages, imageExtensions } = require('./image-input.cjs');
const {
  RevisionConflictError, validateAbsolutePath, validateDocument,
  pathKey, isWithin, isDocumentPath,
} = require('./file-store.cjs');

const TEST_MODE = process.env.MEKI_TEST === '1';
const DOCUMENT_FILTERS = [
  { get name() { return t("Markdown 文档"); }, extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn'] },
  { get name() { return t("文本文件"); }, extensions: ['txt'] },
];
const appDirectory = path.resolve(__dirname, '..');
const { createExportService } = require('./export-service.cjs');
const rendererDirectory = path.join(appDirectory, 'dist');
const rendererFile = path.join(rendererDirectory, 'index.html');

async function createEditorWindow(options) {
const { store, lifecycle, snapshots, updates, coordinator, id } = options;
const authorizedDocuments = new Set();
const pendingCommands = [];
const launchPaths = [];
let mainWindow = null;
let attachments;
let imageHosting;
let workspace = null;
let workspaceStore = null;
let recovery = null;
let rendererBooted = false;
let commandsReady = false;
let closingAllowed = false;
let windowSaveTimer;
let saveOperation = null;
let saveInput = null;
let activeDocument = { name: t("未命名.md"), path: null, dirty: false };
let bootResult = null;
let shortcutCapture = false;

const developerUrl = (() => {
  if (!process.env.MEKI_DEV_URL) return null;
  const candidate = new URL(process.env.MEKI_DEV_URL);
  if (candidate.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname)) {
    throw new Error('MEKI_DEV_URL must point to a local HTTP development server.');
  }
  return candidate.href;
})();

function isTrustedRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    if (developerUrl) return url.origin === new URL(developerUrl).origin;
    return url.protocol === 'file:' && pathKey(fileURLToPath(url)) === pathKey(rendererFile);
  } catch { return false; }
}

function register(method, action) {
  coordinator.register(id, method, action);
}

function authorize(filePath) {
  filePath = validateAbsolutePath(filePath);
  if (!isDocumentPath(filePath)) throw new Error('Choose a Markdown or text file.');
  authorizedDocuments.add(pathKey(filePath));
  return filePath;
}

function requireAuthorized(filePath) {
  filePath = validateAbsolutePath(filePath);
  if (!authorizedDocuments.has(pathKey(filePath))) throw new Error('Open this file using the file dialog or folder sidebar first.');
  return filePath;
}

function sendCommand(command, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererBooted || !commandsReady) {
    pendingCommands.push([command, payload]);
    return;
  }
  mainWindow.webContents.send('meki:command', command, payload);
}

function flushCommands() {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererBooted || !commandsReady) return;
  for (const [command, payload] of pendingCommands.splice(0)) mainWindow.webContents.send('meki:command', command, payload);
}

function acceptLaunchPath(filePath) {
  try {
    const absolute = authorize(path.resolve(filePath));
    if (rendererBooted) sendCommand('open-path', absolute);
    else launchPaths.push(absolute);
  } catch (error) { console.warn('Meki ignored an unsupported launch path:', error.message); }
}

async function rememberDocument(document) {
  authorize(document.path);
  await store.locked('recent-documents', async () => {
    const recents = [{ path: document.path, name: document.name }, ...store.metadata.recentFiles.filter((item) => pathKey(item.path) !== pathKey(document.path))].slice(0, 16);
    await store.updateMetadata({ recentFiles: recents });
  });
  if (!TEST_MODE) app.addRecentDocument(document.path);
  rebuildMenu();
  return document;
}

async function openKnownDocument(filePath) {
  if (workspaceStore && isWithin(filePath,workspaceStore.root)) await workspaceStore.existing(filePath,{document:true});
  const doc = await store.readDocument(requireAuthorized(filePath));
  if (!coordinator.claim(id, doc.path)) return null;
  try { return await rememberDocument(doc); }
  catch (error) { coordinator.releaseClaim(id, doc.path); throw error; }
}

async function chooseOpenPath() {
  if (TEST_MODE) {
    const selected = process.env.MEKI_TEST_OPEN_PATH;
    return selected ? authorize(selected) : null;
  }
  const result = await dialog.showOpenDialog(mainWindow, { title: t("打开 Markdown 文档"), filters: DOCUMENT_FILTERS, properties: ['openFile'] });
  return result.canceled || !result.filePaths[0] ? null : authorize(result.filePaths[0]);
}

function suggestedFilename(name, extension) {
  const basename = typeof name === 'string' ? name.split(/[\\/]/).pop() : t("未命名");
  const stem = path.parse(basename || t("未命名")).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 160) || t("未命名");
  return `${stem}.${extension}`;
}

async function chooseSavePath(document) {
  if (TEST_MODE) {
    const selected = process.env.MEKI_TEST_SAVE_PATH;
    return selected ? authorize(selected) : null;
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t("保存 Markdown 文档"), defaultPath: document.path || suggestedFilename(document.name, 'md'),
    filters: DOCUMENT_FILTERS, properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  return result.canceled || !result.filePath ? null : authorize(result.filePath);
}

async function chooseConflictAction(filePath) {
  if (TEST_MODE) {
    const answer = process.env.MEKI_TEST_CONFLICT || 'cancel';
    return ['cancel', 'saveAs', 'overwrite'].includes(answer) ? answer : 'cancel';
  }
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: t("文件已在其他应用中更改"),
    message: t("“{0}”已发生更改。", path.basename(filePath)),
    detail: t("Meki保留了你的编辑。你可以另存为一个文件，或明确选择覆盖磁盘上的版本。"),
    buttons: [t("取消"), t("另存为…"), t("覆盖磁盘版本")], defaultId: 0, cancelId: 0, noLink: true,
  });
  return ['cancel', 'saveAs', 'overwrite'][answer.response];
}

async function saveDocument(input) {
  let document = validateDocument(input);
  if (input.saveAs !== undefined && typeof input.saveAs !== 'boolean') throw new TypeError('Invalid save option.');
  if (input.otherPaths !== undefined && (!Array.isArray(input.otherPaths) || input.otherPaths.length > 24)) throw new TypeError('Invalid open document paths.');
  const otherPaths = input.otherPaths?.map(requireAuthorized);
  if (document.path) requireAuthorized(document.path);
  const originalPath = document.path;
  let saveAs = input.saveAs === true || document.path === null;
  let overwrite = false;
  // Each retry requires either a fresh native save target or an explicit conflict decision.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (saveAs) {
      const filePath = await chooseSavePath(document);
      if (!filePath) return null;
      const samePath = originalPath && pathKey(filePath) === pathKey(originalPath);
      document = { ...document, path: filePath, name: path.basename(filePath), revision: samePath ? document.revision : null };
      overwrite = !samePath;
      saveAs = false;
    }
    try {
      const actualSavePath = await fs.promises.realpath(document.path).catch(async error => {
        if (error.code !== 'ENOENT') throw error;
        return path.join(await fs.promises.realpath(path.dirname(document.path)), path.basename(document.path));
      });
      if (otherPaths) {
        if (typeof input.tabId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.tabId)) throw new TypeError('Invalid document tab.');
        if (otherPaths.some(filePath => pathKey(filePath) === pathKey(actualSavePath))) throw new Error(t("该文件已在另一个标签中打开，请切换到那个标签或选择其他保存位置。"));
      }
      lifecycle.assertSaveTarget(actualSavePath, input.tabId);
      if (workspaceStore && isWithin(document.path, workspaceStore.root)) {
        const info = await fs.promises.lstat(document.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (info) await workspaceStore.existing(document.path, { document: true });
      }
      if (TEST_MODE && process.env.MEKI_TEST_SAVE_DELAY) {
        process.env.MEKI_TEST_SAVE_PENDING = '1';
        try { await new Promise(resolve => setTimeout(resolve, Math.min(3000, Number(process.env.MEKI_TEST_SAVE_DELAY) || 0))); }
        finally { delete process.env.MEKI_TEST_SAVE_PENDING; }
      }
      const saved = await coordinator.saveTarget(id, actualSavePath, input.tabId, () => store.saveDocument(document, { overwrite, formatFrom: originalPath, beforeReplace: (filePath, bytes) => lifecycle.record(filePath, bytes) }));
      if (!originalPath && input.tabId) {
        await snapshots.adopt(input.tabId, saved.path).catch(error => {
          console.warn('Meki saved the file but retained snapshots under their original draft:', error.message);
          sendCommand('snapshot-warning', t("文稿已保存，但快照路径更新失败；原快照数据已保留。"));
        });
      }
      await rememberDocument(saved).catch(error => console.warn('Meki saved the file but could not update recents:', error.message));
      return saved;
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      const answer = await chooseConflictAction(document.path);
      if (answer === 'cancel') return null;
      if (answer === 'saveAs') { saveAs = true; overwrite = false; }
      else overwrite = true;
    }
  }
  throw new Error('The file keeps changing in another application. Save it under a different name.');
}

async function setWorkspace(root, requireSamePath = false) {
  const selected = await WorkspaceStore.open(root);
  if (requireSamePath && pathKey(selected.root) !== pathKey(root)) throw new Error(t("该最近文件夹已被替换或链接到其他位置，请通过“打开文件夹”重新选择。"));
  const result = await selected.snapshot();
  await store.changeRecentFolders('remember', result.root);
  for (const entry of result.entries) authorize(entry.path);
  workspaceStore = selected;
  workspace = result;
  await coordinator.sessions.update(id, { workspaceRoot: result.root });
  rebuildMenu();
  return result;
}

async function refreshWorkspace() {
  if (!workspaceStore) return null;
  const selected = workspaceStore;
  const result = await selected.snapshot();
  if (selected !== workspaceStore) return workspace;
  for (const entry of result.entries) authorize(entry.path);
  workspace = result;
  return workspace;
}

async function mutateWorkspace(input) {
  if (!workspaceStore) throw new Error(t("请先打开工作区文件夹。"));
  if (saveOperation) await saveOperation;
  return store.locked('workspace-operation', async () => {
    coordinator.assertWorkspaceOperation(id, input);
    const selected = workspaceStore;
    if (input?.action === 'trash') {
      const entry = await selected.existing(input.path);
      let confirmed = false;
      if (TEST_MODE) confirmed = process.env.MEKI_TEST_TRASH === 'confirm';
      else {
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: t("移入回收站"), message: t("将“{0}”{1}移入系统回收站？", path.basename(entry.path), entry.stat.isDirectory() ? t("及其全部内容") : ''),
          detail: t("可在系统回收站中恢复。当前打开的文稿内容会保留在编辑器中；不会永久删除。"),
          buttons: [t("取消"), t("移入回收站")], defaultId: 0, cancelId: 0, noLink: true,
        });
        confirmed = answer.response === 1;
      }
      if (!confirmed) return null;
    }
    const result = await selected.operate(input, filePath => shell.trashItem(filePath));
    if (result.path && isDocumentPath(result.path)) authorize(result.path);
    let warning;
    if (result.previousPath && ['rename', 'move', 'trash'].includes(result.action)) {
      const remap = filePath => filePath && isWithin(filePath, result.previousPath)
        ? result.path ? path.join(result.path, path.relative(result.previousPath, filePath)) : null : filePath;
      for (const key of [...authorizedDocuments]) {
        const target = remap(key);
        if (target !== key) { authorizedDocuments.delete(key); if (target) authorizedDocuments.add(pathKey(target)); }
      }
      for (const [key, format] of [...store.formats]) {
        const target = remap(key);
        if (target !== key) { store.formats.delete(key); if (target) store.formats.set(pathKey(target), format); }
      }
      const recents = store.metadata.recentFiles.flatMap(entry => {
        const target = remap(entry.path); return target ? [{ path: target, name: path.basename(target) }] : [];
      });
      try { await store.updateMetadata({ recentFiles: recents }); }
      catch (error) { warning = t("文件操作已完成，但最近文稿记录保存失败：{0}", error.message); }
      const draft = await store.loadDraft();
      if (draft?.path && remap(draft.path) !== draft.path) {
        const target = remap(draft.path);
        try { await store.saveDraft({ ...draft, path: target, name: target ? path.basename(target) : draft.name, revision: target ? draft.revision : null }); }
        catch (error) { warning = t("文件操作已完成，但恢复草稿路径保存失败：{0}", error.message); }
      }
      const activePath = remap(activeDocument.path);
      if (activePath !== activeDocument.path) { activeDocument = { ...activeDocument, path: activePath, name: activePath ? path.basename(activePath) : activeDocument.name }; updateWindowTitle(); }
      rebuildMenu();
      try { await lifecycle.remap(result.previousPath, result.path); }
      catch (error) { warning = t("文件操作已完成，但版本历史路径更新失败：{0}", error.message); }
      try { await snapshots.remap(result.previousPath, result.path); }
      catch (error) { warning = t("文件操作已完成，快照保留在原路径下：{0}", error.message); }
      try { await lifecycle.remapSession(result.previousPath, result.path); }
      catch (error) { warning = t("文件操作已完成，但会话路径保存失败：{0}", error.message); }
    }
    let refreshed = workspace;
    try { refreshed = await refreshWorkspace(); }
    catch (error) { warning = t("文件操作已完成，请刷新文件树：{0}", error.message); }
    // Report the new path even if optional metadata/refresh fails after a successful filesystem operation.
    return { ...result, workspace: refreshed, warning };
  });
}

async function askDiscard(name) {
  if (typeof name !== 'string' || name.length > 512) throw new TypeError('Invalid document name.');
  if (TEST_MODE) {
    let answer = process.env.MEKI_TEST_DISCARD || 'cancel';
    if (process.env.MEKI_TEST_DISCARD_SEQUENCE) {
      const sequence = JSON.parse(process.env.MEKI_TEST_DISCARD_SEQUENCE);
      if (Array.isArray(sequence) && sequence.length) { answer = sequence.shift(); process.env.MEKI_TEST_DISCARD_SEQUENCE = JSON.stringify(sequence); }
    }
    return ['save', 'discard', 'cancel'].includes(answer) ? answer : 'cancel';
  }
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: t("保存你的修改？"), message: t("要保存对“{0}”的修改吗？", name || t("未命名.md")),
    detail: t("选择“不保存”将放弃尚未保存的修改。"), buttons: [t("保存"), t("不保存"), t("取消")],
    defaultId: 0, cancelId: 2, noLink: true,
  });
  return ['save', 'discard', 'cancel'][answer.response];
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(`${activeDocument.dirty ? '● ' : ''}${activeDocument.name || t("未命名.md")} — Meki`);
  if (process.platform === 'darwin') {
    mainWindow.setDocumentEdited(activeDocument.dirty);
    mainWindow.setRepresentedFilename(activeDocument.path || '');
  }
}

function registerIpc() {
  register('shortcut-capture', active => {
    if (typeof active !== 'boolean') throw new Error(t("无效快捷键捕获状态。"));
    shortcutCapture = active; mainWindow.webContents.setIgnoreMenuShortcuts(active);
  });
  register('update-shortcut', input => store.locked('shortcut-settings', async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(t("无效快捷键设置。"));
    let shortcuts = { ...store.metadata.settings.shortcuts };
    if (input.resetAll === true && Object.keys(input).length === 1) shortcuts = {};
    else {
      if (Object.keys(input).some(key => !['command', 'value'].includes(key)) || !shortcutIds.has(input.command)) throw new Error(t("未知快捷键命令。"));
      if (input.value === 'default') delete shortcuts[input.command]; else shortcuts[input.command] = input.value;
    }
    const settings = await store.updateSettings({ shortcuts: validateBindings(shortcuts, process.platform) });
    coordinator.settingsChanged(id, { shortcuts: settings.shortcuts }); return settings;
  }));
  register('reopen-closed-document', async input => {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['path', 'revision', 'dirty'].includes(key)) || typeof input.dirty !== 'boolean') throw new Error(t("无效的已关闭文稿。"));
    const file = requireAuthorized(input.path);
    validateDocument({ path: file, name: '', content: '', revision: input.revision });
    const owner = coordinator.owner(file);
    if (owner && owner !== id) {
      if (input.dirty) return { kind: 'copy', message: t("原文件在另一个窗口打开，已将关闭前修改恢复为未命名副本。") };
      coordinator.claim(id, file); return { kind: 'existing', message: t("原文稿已在另一个窗口打开，已切换到对应窗口。") };
    }
    let document;
    try { document = await store.readDocument(file); }
    catch (error) { if (error.code === 'ENOENT') return { kind: 'copy', message: t("原文件已不存在，已将关闭前内容恢复为未命名副本。") }; throw error; }
    if (pathKey(document.path) !== pathKey(file)) return { kind: 'copy', message: t("原路径已指向另一份文稿，关闭前内容已恢复为未命名副本。") };
    if (input.dirty && input.revision !== document.revision) return { kind: 'copy', message: t("原文件已在外部修改，关闭前修改已恢复为未命名副本；磁盘内容保持不变。") };
    if (!coordinator.claim(id, document.path)) return input.dirty ? { kind: 'copy', message: t("原文件已在其他窗口打开，已恢复为未命名副本。") } : { kind: 'existing' };
    try { await rememberDocument(document); return { kind: input.dirty ? 'buffer' : 'disk', document }; }
    catch (error) { coordinator.releaseClaim(id, document.path); throw error; }
  });
  const updater = () => { if (!updates) throw new Error(t("更新缓存不可用，请检查应用数据目录。")); return updates; };
  register('update-state', () => updater().snapshot());
  register('check-update', () => updater().check());
  register('set-automatic-updates', enabled => updater().setAutomatic(enabled));
  register('dismiss-update-notification', version => updater().dismissNotification(version));
  register('download-update', () => updater().download());
  register('cancel-update', () => updater().cancel());
  register('apply-update', async () => {
    if (coordinator.count() > 1) throw new Error(t("请先关闭其他编辑窗口，再应用更新。"));
    if (saveOperation) await saveOperation;
    await persistWindowBounds();
    const ready = updater().prepareApply();
    if (TEST_MODE) {
      if (ready.kind === 'payload') bootstrap.runtime.activate(ready.manifest.asarSha256);
      fs.writeFileSync(path.join(app.getPath('userData'), 'update-apply-test.json'), JSON.stringify({ kind: ready.kind, version: ready.manifest.version }));
      return;
    }
    await coordinator.finishUpdate(id);
    if (ready.kind === 'installer') {
      const error = await shell.openPath(ready.path); if (error) throw new Error(t("无法打开安装器，请重试。"));
    } else { bootstrap.runtime.activate(ready.manifest.asarSha256); app.relaunch(); }
    closingAllowed = true; coordinator.allowQuit(); setImmediate(() => app.quit());
  });
  registerClipboardText(register, clipboard);
  register('commands-ready', () => {
    commandsReady = true;
    try { bootstrap?.runtime?.healthy(); } catch { console.warn('Meki could not acknowledge the updated application startup.'); }
    flushCommands();
    coordinator.ready(id);
    options.initialSession = undefined; options.transferred = false;
    if (!TEST_MODE) mainWindow.show();
  });
  register('new-window', () => coordinator.newWindow(id));
  register('detach-document', tabId => coordinator.detach(id, tabId));
  register('tile-windows', () => coordinator.tile(id));
  register('cancel-close', () => coordinator.cancelClose(id));
  register('release-document', file => coordinator.releaseClaim(id, file));
  register('boot', async () => {
    if (bootResult) return { ...bootResult, settings: store.metadata.settings, recentFiles: store.metadata.recentFiles, recentFolders: store.metadata.recentFolders, workspace };
    let initialDoc = null;
    const firstLaunchPath = launchPaths.shift();
    const session = options.initialSession || await lifecycle.restore(store.metadata.settings.reopenSession);
    for (const doc of session?.documents || []) if (doc.path) authorize(doc.path);
    const reopenPath = firstLaunchPath || (!options.fresh && !session && !recovery && store.metadata.settings.reopenSession ? store.metadata.recentFiles[0]?.path : null);
    if (reopenPath) {
      try { initialDoc = await openKnownDocument(reopenPath); }
      catch (error) { console.warn('Meki could not restore its last document:', error.message); }
    }
    bootResult = {
      platform: process.platform, version: bootstrap?.runtime?.version || app.getVersion(), locale: getLocale(), settings: store.metadata.settings,
      recovery: session ? null : recovery, session, initialDoc: initialDoc || (options.fresh ? { path: null, name: t("未命名.md"), content: '', revision: null } : null), transferred: options.transferred === true, windowId: id, recentFiles: store.metadata.recentFiles, recentFolders: store.metadata.recentFolders, workspace,
    };
    rendererBooted = true;
    for (const filePath of launchPaths.splice(0)) pendingCommands.push(['open-path', filePath]);
    setImmediate(flushCommands);
    return bootResult;
  });
  register('open-document', async (filePath) => {
    const selected = filePath === undefined ? await chooseOpenPath() : requireAuthorized(filePath);
    return selected ? openKnownDocument(selected) : null;
  });
  register('save-document', (input) => {
    // Identical keyboard/menu invocations may share a save. Never return an older save for newer edits.
    const document = validateDocument(input);
    if (saveOperation) {
      if (!saveInput.automatic && saveInput.content === document.content && saveInput.path === document.path && saveInput.revision === document.revision && saveInput.saveAs === input.saveAs && saveInput.tabId === input.tabId) return saveOperation;
      throw new Error(t("正在保存上一版修改，请稍后再次保存。"));
    }
    saveInput = { ...document, saveAs: input.saveAs, tabId: input.tabId };
    saveOperation = saveDocument(input).finally(() => { saveOperation = null; saveInput = null; });
    return saveOperation;
  });
  register('auto-save-document', (input) => {
    const document = validateDocument(input, { requirePath: true });
    requireAuthorized(document.path);
    lifecycle.assertSaveTarget(document.path, input.tabId);
    const sessionDocument = lifecycle.session?.documents.find(doc => doc.id === input.tabId && doc.path && pathKey(doc.path) === pathKey(document.path));
    if (!sessionDocument || sessionDocument.paused) return { status: 'paused', reason: t("此文稿需要手动确认保存，自动保存已暂停。") };
    if (!store.metadata.settings.autoSave || !document.revision) throw new Error(t("自动保存只适用于已保存的文稿。"));
    if (saveOperation) throw new Error('Another document is being saved.');
    saveInput = { ...document, automatic: true };
    saveOperation = (async () => {
      try {
        if (workspaceStore && isWithin(document.path, workspaceStore.root)) await workspaceStore.existing(document.path, { document: true });
        const saved = await coordinator.saveTarget(id, document.path, input.tabId, () => store.saveDocument(document, { beforeReplace: (filePath, bytes) => lifecycle.record(filePath, bytes) }));
        await rememberDocument(saved).catch(error => console.warn('Meki saved the file but could not update recents:', error.message));
        return { status: 'saved', document: saved };
      } catch (error) {
        return { status: 'paused', reason: error instanceof RevisionConflictError ? t("磁盘文件已更改或删除，自动保存已暂停。请重新载入、另存为或手动保存。") : t("自动保存已暂停：{0}", error.message) };
      }
    })().finally(() => { saveOperation = null; saveInput = null; });
    return saveOperation;
  });
  register('save-session', async (input, forClose = false) => {
    if (typeof forClose !== 'boolean') throw new Error(t("无效的会话保存选项。"));
    const session = validateSession(input);
    for (const doc of session.documents) if (doc.path) requireAuthorized(doc.path);
    if (forClose) { coordinator.stageClose(id, session); return; }
    await lifecycle.saveSession(session);
    coordinator.sessionSaved(id, session);
    // Once the whole session is safely stored, the old single-document draft is redundant.
    // Cleanup cannot turn an authoritative commit into a failure and roll the renderer back.
    try { await store.saveDraft(null); }
    catch (error) { console.warn('Meki saved its window session but could not remove the legacy draft:', error.message); }
    recovery = null;
  });
  register('list-versions', filePath => lifecycle.list(requireAuthorized(filePath)));
  register('read-version', (filePath, id) => lifecycle.read(requireAuthorized(filePath), id));
  register('clear-versions', filePath => lifecycle.clear(requireAuthorized(filePath)));
  register('create-snapshot', input => {
    const document = validateDocument(input), target = validateTarget(input);
    if (document.path) requireAuthorized(document.path);
    const saved = lifecycle.session?.documents.find(doc => doc.id === target.tabId);
    if (!saved || (saved.path ? pathKey(saved.path) : null) !== (target.path ? pathKey(target.path) : null)) throw new Error(t("文稿已切换，请重新创建快照。"));
    if (input.kind === 'auto' && !store.metadata.settings.autoSnapshot) throw new Error(t("自动快照已关闭。"));
    return snapshots.create({ ...document, ...target, kind: input.kind, label: input.label });
  });
  register('list-snapshots', target => snapshots.list(target));
  register('read-snapshot', id => snapshots.read(id));
  register('delete-snapshot', async id => {
    const entry = snapshots.list().find(item => item.id === id);
    if (!entry) throw new Error(t("此快照已不可用。"));
    const confirmed = TEST_MODE ? process.env.MEKI_TEST_DELETE_SNAPSHOT === 'confirm' : (await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: t("删除版本"), message: t("删除“{0}”？", entry.label || new Date(entry.createdAt).toLocaleString()),
      detail: t("只删除此历史版本，当前文稿和原文件保持不变。此操作无法撤销。"), buttons: [t("取消"), t("删除版本")], defaultId: 0, cancelId: 0, noLink: true,
    })).response === 1;
    if (confirmed) await snapshots.delete(id);
    return confirmed;
  });
  register('choose-folder', async () => {
    let selected;
    if (TEST_MODE) selected = process.env.MEKI_TEST_FOLDER_PATH;
    else {
      const result = await dialog.showOpenDialog(mainWindow, { title: t("打开 Markdown 文件夹"), properties: ['openDirectory'] });
      if (result.canceled) return null;
      selected = result.filePaths[0];
    }
    return selected ? setWorkspace(validateAbsolutePath(selected)) : null;
  });
  register('refresh-workspace', refreshWorkspace);
  register('list-recent-folders', () => store.metadata.recentFolders);
  register('open-recent-folder', async folder => {
    folder = validateAbsolutePath(folder);
    if (!store.metadata.recentFolders.some(entry => pathKey(entry.path) === pathKey(folder))) throw new Error(t("该文件夹不在最近记录中，请通过“打开文件夹”选择。"));
    try { return await setWorkspace(folder, true); }
    catch (error) { throw new Error(t("无法打开最近文件夹“{0}”：{1}", folder, error.message)); }
  });
  register('change-recent-folders', async input => {
    if (!input || typeof input !== 'object' || !['pin', 'unpin', 'remove', 'clear'].includes(input.action)) throw new TypeError(t("无效的最近文件夹操作。"));
    const folders = await store.changeRecentFolders(input.action, input.path);
    rebuildMenu(); return folders;
  });
  register('workspace-operation', mutateWorkspace);
  register('search-workspace', (query, caseSensitive = false) => {
    if (!workspaceStore) throw new Error(t("请先打开工作区文件夹。"));
    return workspaceStore.search(query, caseSensitive);
  });
  register('workspace-path-action', async (action, filePath) => {
    if (!workspaceStore || !['reveal', 'copy-path'].includes(action)) throw new Error(t("无效的工作区操作。"));
    const entry = await workspaceStore.existing(filePath, { root: true });
    if (action === 'copy-path') {
      if (TEST_MODE) process.env.MEKI_TEST_COPIED_PATH = entry.path;
      else await clipboard.writeText(entry.path);
    }
    else if (!TEST_MODE) shell.showItemInFolder(entry.path);
  });
  register('resolve-document-link', async (href, documentPath) => {
    requireAuthorized(documentPath);
    const boundary = workspaceStore && isWithin(documentPath, workspaceStore.root) ? workspaceStore : await WorkspaceStore.open(path.dirname(documentPath));
    const result = await boundary.resolveLink(href, documentPath);
    authorize(result.path);
    return result;
  });
  register('check-document', (filePath, revision) => documentStatus(requireAuthorized(filePath), revision));
  register('save-draft', async (draft) => {
    if (draft?.path) requireAuthorized(draft.path);
    await store.saveDraft(draft);
    recovery = draft;
  });
  register('update-settings', async (patch) => {
    const settings = await store.updateSettings(patch);
    session.defaultSession.setSpellCheckerEnabled(settings.spellcheck);
    coordinator.settingsChanged(id, patch);
    rebuildMenu();
    return settings;
  });
  register('import-theme', async () => {
    let selected;
    if (TEST_MODE) selected = process.env.MEKI_TEST_THEME_PATH;
    else {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: t("导入 CSS 主题"), filters: [{ name: t("CSS 主题"), extensions: ['css'] }], properties: ['openFile'],
      });
      if (result.canceled) return null;
      selected = result.filePaths[0];
    }
    return selected ? store.readTheme(selected) : null;
  });
  register('confirm-discard', askDiscard);
  const exporting = createExportService(() => mainWindow, () => activeDocument, store);
  register('export-file', exporting.exportFile);
  register('export-tools', exporting.exportTools);
  register('list-export-presets', exporting.listExportPresets);
  register('save-export-preset', exporting.saveExportPreset);
  register('delete-export-preset', exporting.deleteExportPreset);
  register('choose-export-reference', exporting.chooseExportReference);
  register('delete-export-reference', exporting.deleteExportReference);
  register('choose-pandoc', exporting.choosePandoc);
  register('import-document', exporting.importDocument);
  register('save-diagram', exporting.saveDiagram);
  register('asset-url', (source, documentPath) => {
    if (documentPath !== null) requireAuthorized(documentPath);
    return store.assetUrl(source, documentPath, workspace?.root);
  });
  register('save-attachment', (input) => {
    if (!input || !input.documentPath) throw new Error(t("先保存文档，再添加图片。"));
    requireAuthorized(input.documentPath);
    return store.saveAttachment(input, workspace?.root);
  });
  register('choose-images', async () => {
    const selected = TEST_MODE ? JSON.parse(process.env.MEKI_TEST_IMAGE_PATHS || '[]') : (await dialog.showOpenDialog(mainWindow, { title: t("添加图片"), filters: [{ name: t("图片"), extensions: imageExtensions }], properties: ['openFile', 'multiSelections'] })).filePaths;
    return selected.length ? readSelectedImages(selected) : null;
  });
  register('save-attachments', async (input) => {
    if (!input || !input.documentPath) throw new Error(t("先保存文稿，再添加图片。"));
    requireAuthorized(input.documentPath);
    if (TEST_MODE && process.env.MEKI_TEST_IMAGE_DELAY) await new Promise(resolve => setTimeout(resolve, Math.min(2000, Number(process.env.MEKI_TEST_IMAGE_DELAY) || 0)));
    return store.saveAttachments(input, workspace?.root);
  });
  register('prepare-attachments', input => attachments.prepare(input));
  register('commit-attachments', id => attachments.commit(id));
  register('finish-attachments', (id, keep) => attachments.finish(id, keep));
  register('cancel-image-download', () => attachments.cancel());
  register('check-image-host', () => imageHosting.check());
  register('prepare-image-upload', input => imageHosting.prepare(input));
  register('upload-prepared-images', id => imageHosting.uploadPrepared(id));
  register('upload-images', images => {
    if (!store.metadata.settings.imageAutoUpload) throw new Error(t("插入图片自动上传尚未开启。"));
    return imageHosting.uploadImages(images);
  });
  register('cancel-image-upload', () => imageHosting.cancel());
  register('abandon-image-upload', () => imageHosting.abandon());
  register('set-document-state', (input) => {
    if (!input || typeof input.name !== 'string' || input.name.length > 512 || typeof input.dirty !== 'boolean') throw new TypeError('Invalid document state.');
    if (input.path !== null) requireAuthorized(input.path);
    const renamed = activeDocument.name !== input.name || activeDocument.path !== input.path;
    activeDocument = { name: input.name, path: input.path, dirty: input.dirty };
    updateWindowTitle();
    if (renamed) coordinator.refreshMenus();
  });
  register('allow-close', async () => {
    if (saveOperation) await saveOperation;
    await persistWindowBounds();
    return coordinator.approveClose(id);
  });
  register('open-external', async (value) => {
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20]/.test(value)) throw new TypeError('Invalid external link.');
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Only web and email links can be opened.');
    await shell.openExternal(url.href);
  });
  register('dropped-document', (filePath) => {
    sendCommand('open-path', authorize(filePath));
  });
}

function rebuildMenu() {
  if (!store) return;
  const mac = process.platform === 'darwin';
  const shortcuts = bindings(store.metadata.settings.shortcuts, process.platform);
  const item = (label, command, legacyAccelerator, extra = {}) => ({ label, id: `command-${command}`, accelerator: shortcutIds.has(command) ? accelerator(shortcuts[command], process.platform) : legacyAccelerator, click: () => sendCommand(command), ...extra });
  const fileMenu = [
    item(t("新建"), 'new', 'CmdOrCtrl+N'), item(t("新建窗口"), 'new-window', 'CmdOrCtrl+Shift+N'), item(t("打开…"), 'open', 'CmdOrCtrl+O'),
    item(t("快速打开…"), 'quick-open', 'CmdOrCtrl+K'), item(t("搜索工作区…"), 'workspace-search', 'CmdOrCtrl+Shift+K'),
    item(t("打开文件夹…"), 'folder', 'CmdOrCtrl+Shift+O'),
    { label: t("最近打开"), submenu: store.metadata.recentFiles.length ? store.metadata.recentFiles.map((entry) => ({
      label: entry.name, sublabel: entry.path, click: () => sendCommand('open-path', authorize(entry.path)),
    })) : [{ label: t("暂无最近文档"), enabled: false }] },
    { label: t("最近文件夹"), submenu: [...store.metadata.recentFolders.map(entry => ({
      label: `${entry.pinned ? '★ ' : ''}${entry.name}`, sublabel: entry.path, click: () => sendCommand('open-folder', entry.path),
    })), ...(store.metadata.recentFolders.length ? [{ type: 'separator' }] : []), item(t("管理最近文件夹…"), 'recent-folders')] },
    { type: 'separator' }, item(t("保存"), 'save', 'CmdOrCtrl+S'), item(t("另存为…"), 'saveAs', 'CmdOrCtrl+Shift+S'),
    item(t("自动保存"), 'toggle-autosave', undefined, { type: 'checkbox', checked: store.metadata.settings.autoSave }),
    item(t("版本历史…"), 'snapshots'), item(t("文稿与保存设置…"), 'lifecycle-settings'),
    { type: 'separator' }, item(t("导出 HTML…"), 'export-html'), item(t("导出 PDF…"), 'export-pdf', 'CmdOrCtrl+P'), item(t("更多格式与导出设置…"), 'export-options'), item(t("导入 Word / HTML…"), 'import-document'),
    { type: 'separator' }, item(t("图床设置…"), 'image-hosting'), item(t("上传文稿图片…"), 'upload-document-images'), item(t("整理图片附件…"), 'organize-attachments'), item(t("写入前的文件版本…"), 'history'),
    item(t("关闭文稿"), 'close-tab', 'CmdOrCtrl+W'), item(t("关闭全部文稿"), 'close-all', 'CmdOrCtrl+Shift+W'),
    item(t("重新打开刚关闭文稿"), 'reopen-closed'),
    { label: t("关闭窗口"), click: () => mainWindow?.close() },
  ];
  if (process.platform !== 'darwin') fileMenu.push({ label: t("退出"), accelerator: 'Alt+F4', click: () => app.quit() });
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'Meki', submenu: [
      item(t("关于 Meki"), 'about'), item(t("检查更新…"), 'updates'), { type: 'separator' }, { role: 'services', label: t("服务") },
      { type: 'separator' }, { role: 'hide', label: t("隐藏 Meki") }, { role: 'hideOthers', label: t("隐藏其他") },
      { role: 'unhide', label: t("显示全部") }, { type: 'separator' }, { label: t("退出 Meki"), accelerator: 'Cmd+Q', click: () => app.quit() },
    ] }] : []),
    { label: t("文件"), submenu: fileMenu },
    { label: t("编辑"), submenu: [
      { role: 'undo', label: t("撤销") }, { role: 'redo', label: t("重做") }, { type: 'separator' },
      { role: 'cut', label: t("剪切") }, { role: 'copy', label: t("复制") }, { role: 'paste', label: t("粘贴") },
      { type: 'separator' }, item(t("复制为纯文本"), 'edit-copy-text', 'CmdOrCtrl+Shift+C'), item(t("复制为 Markdown"), 'edit-copy-markdown', 'CmdOrCtrl+Alt+C'),
      item(t("粘贴纯文本"), 'edit-paste-text', 'CmdOrCtrl+Shift+V'), item(t("粘贴 Markdown"), 'edit-paste-markdown', 'CmdOrCtrl+Alt+V'),
      { role: 'selectAll', label: t("全选") }, { type: 'separator' }, item(t("查找"), 'find', 'CmdOrCtrl+F'),
      item(t("查找与替换"), 'replace', mac ? 'Cmd+Alt+F' : 'Ctrl+H'),
      item(t("下一个匹配"), 'find-next', mac ? 'Cmd+G' : 'F3'),
      item(t("上一个匹配"), 'find-prev', mac ? 'Cmd+Shift+G' : 'Shift+F3'),
      { type: 'separator' }, item(t("自定义快捷键…"), 'shortcut-settings'),
      { type: 'separator' }, item(t("拼写检查"), 'spellcheck', undefined, { type: 'checkbox', checked: store.metadata.settings.spellcheck }),
    ] },
    { label: t("视图"), submenu: [
      item(t("Markdown 源码"), 'source', 'CmdOrCtrl+/'),
      item(t("专注模式"), 'focus', 'CmdOrCtrl+Shift+F', { type: 'checkbox', checked: store.metadata.settings.focus }),
      item(t("打字机滚动"), 'typewriter', undefined, { type: 'checkbox', checked: store.metadata.settings.typewriter }),
      item(t("当前段落聚焦"), 'paragraph-focus', undefined, { type: 'checkbox', checked: store.metadata.settings.paragraphFocus }),
      item(t("代码块行号"), 'edit-code-lines', undefined, { type: 'checkbox', checked: store.metadata.settings.codeLineNumbers }),
      item(t("显示标题编号"), 'edit-heading-numbering', undefined, { type: 'checkbox', checked: store.metadata.settings.headingNumbering }),
      item(t("代码块设置…"), 'edit-code-settings'),
      { type: 'separator' }, { role: 'resetZoom', label: t("实际大小") }, { role: 'zoomIn', label: t("放大") },
      { role: 'zoomOut', label: t("缩小") }, { type: 'separator' }, { role: 'togglefullscreen', label: t("全屏") },
      ...(developerUrl ? [{ type: 'separator' }, { role: 'toggleDevTools', label: t("开发者工具") }] : []),
    ] },
    { label: t("插入"), submenu: [
      item(t("图片…"), 'image'), item(t("链接…"), 'edit-link', 'CmdOrCtrl+Alt+K'), item(t("表格…"), 'edit-table'), item(t("脚注…"), 'edit-footnote'),
      { type: 'separator' }, item(t("任务列表"), 'edit-task'), item(t("目录"), 'edit-toc'), item(t("提示块"), 'edit-alert'), item(t("数学公式…"), 'math'), item(t("Mermaid 图表"), 'diagram'),
    ] },
    { label: t("窗口"), submenu: [item(t("新建窗口"), 'new-window'), item(t("将当前文稿移至新窗口"), 'detach-document'), item(t("左右并排"), 'tile-windows'), { type: 'separator' }, ...coordinator.windowMenu(id), { type: 'separator' }, { role: 'minimize', label: t("最小化") }, { role: 'zoom', label: t("缩放") }, ...(process.platform === 'darwin' ? [{ role: 'front', label: t("前置全部窗口") }] : [])] },
    { label: t("帮助"), submenu: [item(t("使用指南与快捷键"), 'help'), item(t("检查更新…"), 'updates'), { type: 'separator' }, item(t("关于 Meki"), 'about')] },
  ];
  const menu = Menu.buildFromTemplate(template);
  if (mainWindow && process.platform !== 'darwin') mainWindow.setMenu(menu);
  if (!BrowserWindow.getFocusedWindow() || mainWindow?.isFocused()) Menu.setApplicationMenu(menu);
}

function restoredBounds() {
  const saved = coordinator.sessions.get(id).bounds || store.metadata.windowBounds;
  if (!saved) return { width: 1220, height: 850 };
  const bounds = { width: saved.width, height: saved.height };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const match = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
    const area = match.workArea;
    bounds.x = Math.max(area.x, Math.min(saved.x, area.x + Math.max(0, area.width - saved.width)));
    bounds.y = Math.max(area.y, Math.min(saved.y, area.y + Math.max(0, area.height - saved.height)));
    bounds.width = Math.min(bounds.width, area.width);
    bounds.height = Math.min(bounds.height, area.height);
  }
  return bounds;
}

async function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return;
  clearTimeout(windowSaveTimer);
  const windowBounds = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
  await coordinator.sessions.update(id, { bounds: windowBounds });
  if (id === 'main') await store.updateMetadata({ windowBounds });
}

function queueWindowSave() {
  clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => persistWindowBounds().catch((error) => console.warn('Could not save window position:', error.message)), 500);
}

function createWindow() {
  session.defaultSession.setSpellCheckerEnabled(store.metadata.settings.spellcheck);
  rendererBooted = false;
  commandsReady = false;
  closingAllowed = false;
  bootResult = null;
  mainWindow = new BrowserWindow({
    ...restoredBounds(), minWidth: 480, minHeight: 420, show: false,
    title: 'Meki', backgroundColor: '#faf9f6', icon: path.join(appDirectory, 'assets', 'icon.png'),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 17 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: true, devTools: Boolean(developerUrl) || TEST_MODE,
      backgroundThrottling: !TEST_MODE,
    },
  });
  const contents = mainWindow.webContents;
  contents.on('before-input-event', (_event, input) => {
    const key = eventBinding(input, process.platform);
    const appKey = commandFor(input, store.metadata.settings.shortcuts, process.platform) || shortcutCatalog.some(item => defaultBinding(item.id, process.platform) === key);
    // The renderer alone dispatches app shortcuts. Native menu clicks still use the same commands.
    contents.setIgnoreMenuShortcuts(shortcutCapture || input.isComposing || !!appKey);
  });
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const items = [];
    if (store.metadata.settings.spellcheck && params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 8)) items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      if (!params.dictionarySuggestions.length) items.push({ label: t("没有拼写建议"), enabled: false });
      items.push({ label: t("加入个人词典"), click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    }
    items.push({ role: 'cut', label: t("剪切"), enabled: params.editFlags.canCut }, { role: 'copy', label: t("复制"), enabled: params.editFlags.canCopy }, { role: 'paste', label: t("粘贴"), enabled: params.editFlags.canPaste }, { role: 'selectAll', label: t("全选") });
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  contents.setWindowOpenHandler(({ url }) => {
    try { const target = new URL(url); if (['https:', 'http:', 'mailto:'].includes(target.protocol)) shell.openExternal(target.href).catch(() => {}); } catch { /* Ignore invalid navigation. */ }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    try {
      const expected = developerUrl ? new URL(url).origin === new URL(developerUrl).origin : url.split(/[?#]/, 1)[0] === pathToFileURL(rendererFile).href;
      if (!expected) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('ready-to-show', () => {
    if (coordinator.sessions.get(id).bounds?.maximized) mainWindow.maximize();
  });
  mainWindow.on('focus', rebuildMenu);
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(event, queueWindowSave);
  mainWindow.on('blur', () => sendCommand('autosave-blur'));
  mainWindow.on('close', (event) => {
    if (closingAllowed) return;
    event.preventDefault();
    coordinator.requestClose(id);
  });
  mainWindow.on('closed', () => { clearTimeout(windowSaveTimer); attachments?.abandon(); imageHosting?.abandon(); mainWindow = null; coordinator.closed(id); });
  contents.on('render-process-gone', async (_event, details) => {
    attachments?.abandon();
    imageHosting?.abandon();
    console.error('Meki renderer stopped:', details.reason);
    coordinator.rendererGone(id);
    if (TEST_MODE || !mainWindow) return;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'error', title: t("编辑器已停止"), message: t("编辑器意外停止。已保存的恢复草稿仍在本机。"),
      buttons: [t("重新打开编辑器"), t("关闭")], defaultId: 0, cancelId: 1,
    });
    if (choice.response === 0) {
      recovery = await store.loadDraft();
      rendererBooted = false; commandsReady = false; bootResult = null;
      contents.reload();
    } else { closingAllowed = true; mainWindow.close(); }
  });
  coordinator.attach(id, controller);
  if (developerUrl) mainWindow.loadURL(developerUrl);
  else mainWindow.loadFile(rendererFile);
  updateWindowTitle();
}

const controller = {
  id, sendCommand, isTrustedRenderer, rebuildMenu, authorize, acceptLaunchPath, persistWindowBounds,
  get window() { return mainWindow; },
  get activeDocument() { return activeDocument; },
  get saveOperation() { return saveOperation; },
  get workspaceRoot() { return workspace?.root || null; },
  close() { closingAllowed = true; mainWindow?.close(); },
  destroy() { closingAllowed = true; mainWindow?.destroy(); },
};
const testDownload = TEST_MODE && process.env.MEKI_TEST_IMAGE_DOWNLOAD_ORIGIN ? createImageDownloader({ allowedAddress: address => address === '127.0.0.1' || address === '::1' }) : null;
attachments = new AttachmentStore({ authorize: requireAuthorized, settings: () => store.metadata.settings, workspace: () => workspace?.root,
  ...(testDownload ? { download: (source, options) => {
    if (new URL(source).origin !== process.env.MEKI_TEST_IMAGE_DOWNLOAD_ORIGIN) throw new Error(t("测试图片来源不匹配。"));
    return testDownload(source, options);
  } } : {}), boundary: async documentPath =>
  workspaceStore && isWithin(documentPath, workspaceStore.root) ? workspaceStore.root : fs.promises.realpath(path.dirname(documentPath)) });
imageHosting = new ImageHosting({ authorize: requireAuthorized, boundary: async documentPath =>
  workspaceStore && isWithin(documentPath, workspaceStore.root) ? workspaceStore.root : fs.promises.realpath(path.dirname(documentPath)),
  settings: () => store.metadata.settings, tempRoot: path.join(app.getPath('userData'), 'image-upload-temp', id) });
for (const entry of store.metadata.recentFiles) authorize(entry.path);
recovery = options.legacyRecovery || null;
if (recovery?.path) authorize(recovery.path);
for (const file of options.launchPaths || []) acceptLaunchPath(file);
const workspaceRoot = coordinator.sessions.get(id).workspaceRoot;
if (workspaceRoot) {
  try { await setWorkspace(workspaceRoot, true); }
  catch (error) { console.warn('Meki could not restore its folder:', error.message); }
}
registerIpc();
createWindow();
rebuildMenu();
return controller;
}
module.exports = { createEditorWindow };

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (method, ...args) => ipcRenderer.invoke(`meki:${method}`, ...args);

contextBridge.exposeInMainWorld('meki', Object.freeze({
  updateState: () => invoke('update-state'),
  checkUpdate: () => invoke('check-update'),
  downloadUpdate: () => invoke('download-update'),
  cancelUpdate: () => invoke('cancel-update'),
  applyUpdate: () => invoke('apply-update'),
  onUpdate: callback => {
    if (typeof callback !== 'function') throw new TypeError('An update callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('meki:update-state', listener);
    return () => ipcRenderer.removeListener('meki:update-state', listener);
  },
  boot: () => invoke('boot'),
  newWindow: () => invoke('new-window'),
  detachDocument: tabId => invoke('detach-document', tabId),
  tileWindows: () => invoke('tile-windows'),
  releaseDocument: file => invoke('release-document', file),
  cancelClose: () => invoke('cancel-close'),
  checkImageHost: () => invoke('check-image-host'),
  prepareImageUpload: input => invoke('prepare-image-upload', input),
  uploadPreparedImages: id => invoke('upload-prepared-images', id),
  uploadImages: images => invoke('upload-images', images),
  cancelImageUpload: () => invoke('cancel-image-upload'),
  abandonImageUpload: () => invoke('abandon-image-upload'),
  openDocument: (filePath) => invoke('open-document', filePath),
  reopenClosedDocument: input => invoke('reopen-closed-document', input),
  updateShortcut: input => invoke('update-shortcut', input),
  shortcutCapture: active => invoke('shortcut-capture', active),
  saveDocument: (document) => invoke('save-document', document),
  autoSaveDocument: (document) => invoke('auto-save-document', document),
  saveSession: (session, forClose = false) => invoke('save-session', session, forClose),
  listVersions: (filePath) => invoke('list-versions', filePath),
  readVersion: (filePath, id) => invoke('read-version', filePath, id),
  clearVersions: (filePath) => invoke('clear-versions', filePath),
  createSnapshot: input => invoke('create-snapshot', input),
  listSnapshots: target => invoke('list-snapshots', target),
  readSnapshot: id => invoke('read-snapshot', id),
  deleteSnapshot: id => invoke('delete-snapshot', id),
  chooseFolder: () => invoke('choose-folder'),
  listRecentFolders: () => invoke('list-recent-folders'),
  openRecentFolder: (folderPath) => invoke('open-recent-folder', folderPath),
  changeRecentFolders: (input) => invoke('change-recent-folders', input),
  refreshWorkspace: () => invoke('refresh-workspace'),
  workspaceOperation: (input) => invoke('workspace-operation', input),
  searchWorkspace: (query, caseSensitive) => invoke('search-workspace', query, caseSensitive),
  workspacePathAction: (action, filePath) => invoke('workspace-path-action', action, filePath),
  resolveDocumentLink: (href, documentPath) => invoke('resolve-document-link', href, documentPath),
  checkDocument: (filePath, revision) => invoke('check-document', filePath, revision),
  saveDraft: (draft) => invoke('save-draft', draft),
  updateSettings: (patch) => invoke('update-settings', patch),
  readClipboardText: () => invoke('read-clipboard-text'),
  writeClipboardText: (text) => invoke('write-clipboard-text', text),
  importTheme: () => invoke('import-theme'),
  confirmDiscard: (name) => invoke('confirm-discard', name),
  exportFile: (input) => invoke('export-file', input),
  listExportPresets: () => invoke('list-export-presets'),
  saveExportPreset: (input) => invoke('save-export-preset', input),
  deleteExportPreset: (id) => invoke('delete-export-preset', id),
  chooseExportReference: () => invoke('choose-export-reference'),
  deleteExportReference: (id) => invoke('delete-export-reference', id),
  exportTools: () => invoke('export-tools'),
  choosePandoc: () => invoke('choose-pandoc'),
  importDocument: () => invoke('import-document'),
  saveDiagram: (input) => invoke('save-diagram', input),
  assetUrl: (source, documentPath) => invoke('asset-url', source, documentPath),
  saveAttachment: (input) => invoke('save-attachment', input),
  chooseImages: () => invoke('choose-images'),
  saveAttachments: (input) => invoke('save-attachments', input),
  prepareAttachments: (input) => invoke('prepare-attachments', input),
  commitAttachments: (id) => invoke('commit-attachments', id),
  finishAttachments: (id, keep) => invoke('finish-attachments', id, keep),
  cancelImageDownload: () => invoke('cancel-image-download'),
  setDocumentState: (input) => invoke('set-document-state', input),
  allowClose: () => invoke('allow-close'),
  openExternal: (url) => invoke('open-external', url),
  onCommand: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A command callback is required.');
    const listener = (_event, command, payload) => callback(command, payload);
    ipcRenderer.on('meki:command', listener);
    void invoke('commands-ready').catch(() => {});
    return () => ipcRenderer.removeListener('meki:command', listener);
  },
}));

// Electron's isolated renderer no longer exposes File.path. Only trusted OS file drops
// may use this small preload bridge; normal image drops remain available to the editor.
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  if (!event.isTrusted || !event.dataTransfer?.files.length) return;
  for (const file of event.dataTransfer.files) {
    if (!/\.(md|markdown|mdown|mkd|mkdn|txt)$/i.test(file.name)) continue;
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) continue;
    event.preventDefault();
    event.stopImmediatePropagation();
    invoke('dropped-document', filePath).catch((error) => console.warn('Could not open dropped file:', error.message));
    break;
  }
}, true);

'use strict';
const { t, setLocale } = require('./i18n.mjs');
const { app, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { FileStore, validateAbsolutePath, isDocumentPath, isWithin } = require('./file-store.cjs');
const { LifecycleStore } = require('./lifecycle-store.cjs');
const { SnapshotStore } = require('./snapshot-store.cjs');
const { WindowSessions } = require('./window-sessions.cjs');
const { WindowManager } = require('./window-manager.cjs');
const { UpdateService } = require('./update-service.cjs');
const { GithubUpdates } = require('./update-network.cjs');
const { configureApp } = require('./app-identity.cjs');
const bootstrap = globalThis[Symbol.for('meki.bootstrap')];
const TEST_MODE = process.env.MEKI_TEST === '1';
let manager, updates, reopening;
let initialized = false;
const launchPaths = [];
configureApp(app);
function accept(file) {
  try {
    file = validateAbsolutePath(path.resolve(file)); if (!isDocumentPath(file)) return;
    if (manager?.count()) manager.focused().acceptLaunchPath(file); else launchPaths.push(file);
  } catch { /* Ignore unrelated command line arguments. */ }
}
function argumentsFrom(argv) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--open' && argv[i + 1]) accept(argv[++i]);
    else if (arg.startsWith('--open=')) accept(arg.slice(7));
    else if (!arg.startsWith('-') && path.isAbsolute(arg) && isDocumentPath(arg)) accept(arg);
  }
}
function reopen() {
  if (reopening) return reopening;
  reopening = (async () => {
    if (manager.count()) { manager.focus(manager.focused().id); return; }
    const records = await manager.sessions.startup(manager.store.metadata.settings.reopenSession);
    for (const record of records) await manager.open(record.id, { launchPaths: launchPaths.splice(0) });
  })().finally(() => { reopening = null; });
  return reopening;
}
app.on('open-file', (event, file) => { event.preventDefault(); accept(file); if (initialized && !manager.count()) void reopen(); });
app.on('before-quit', event => {
  if (manager?.count() && !manager.quitAllowed) { event.preventDefault(); void manager.quit(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || manager?.quitAllowed) app.quit(); });
if (!(bootstrap?.hasLock || app.requestSingleInstanceLock())) app.quit();
else {
  argumentsFrom(process.argv);
  app.on('second-instance', (_event, argv) => { argumentsFrom(argv); if (initialized) void reopen(); });
  app.whenReady().then(async () => {
    const store = new FileStore(app.getPath('userData')); await store.init();
    setLocale(store.metadata.settings.locale);
    const history = new LifecycleStore(store); await history.init();
    const snapshots = new SnapshotStore(store); await snapshots.init();
    const sessions = new WindowSessions(store, history); await sessions.init();
    if (bootstrap?.runtime) {
      updates = new UpdateService({ runtime: bootstrap.runtime,
        network: new GithubUpdates(TEST_MODE && process.env.MEKI_TEST_UPDATE_SERVER ? { testOrigin: process.env.MEKI_TEST_UPDATE_SERVER } : {}),
        notify: state => { for (const controller of manager?.controllers.values() || []) controller.window?.webContents.send('meki:update-state', state); },
      });
    }
    manager = new WindowManager({ store, sessions, snapshots, updates, reopen });
    const canClipboard = (sender, permission, details) => permission === 'clipboard-sanitized-write' && details.isMainFrame === true &&
      [...manager.controllers.values()].some(controller => controller.isTrustedRenderer({ sender, senderFrame: sender?.mainFrame }));
    session.defaultSession.setPermissionRequestHandler((sender, permission, callback, details) => callback(canClipboard(sender, permission, details)));
    session.defaultSession.setPermissionCheckHandler((sender, permission, _origin, details) => canClipboard(sender, permission, details));
    const rendererDirectory = path.resolve(__dirname, '..', 'dist');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
      try { callback({ cancel: !isWithin(fileURLToPath(details.url), rendererDirectory) }); } catch { callback({ cancel: true }); }
    });
    const legacyRecovery = await store.loadDraft();
    const records = await sessions.startup(store.metadata.settings.reopenSession);
    for (const [index, record] of records.entries()) await manager.open(record.id, { launchPaths: index ? [] : launchPaths.splice(0), legacyRecovery: index ? null : legacyRecovery });
    if (sessions.warning) manager.focused()?.sendCommand('window-notice', sessions.warning);
    initialized = true;
    if (!TEST_MODE || process.env.MEKI_TEST_AUTO_UPDATE === '1') updates?.startAutomatic({ delay: TEST_MODE ? 500 : 15000 });
    app.on('will-quit', () => updates?.stopAutomatic());
    app.on('activate', () => { void reopen(); });
  }).catch(error => {
    console.error('Meki could not start:', error);
    if (!TEST_MODE) dialog.showErrorBox(t("Meki 无法启动"), error.message);
    app.exit(1);
  });
}

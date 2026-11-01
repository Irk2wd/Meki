const path = require('node:path');
const { APP_ID, PRODUCT_NAME, WINDOWS_EXECUTABLE } = require('./electron/app-identity.cjs');

module.exports = {
  appId: APP_ID,
  productName: PRODUCT_NAME,
  copyright: 'Copyright (c) 2026 Irk2wd and contributors',
  directories: { buildResources: path.join(__dirname, 'assets') },
  files: ['**/*'],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  forceCodeSigning: false,
  publish: null,
  win: {
    executableName: WINDOWS_EXECUTABLE,
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    artifactName: PRODUCT_NAME + '-${version}-Setup-${arch}.${ext}',
  },
  nsis: {
    // Keep one uninstall registration when upgrading an existing installation.
    guid: '0c6ece60-3a81-54bc-8f44-5a19f608bb2c',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: PRODUCT_NAME,
    uninstallDisplayName: PRODUCT_NAME,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    installerLanguages: ['zh_CN', 'en_US'],
    language: '2052',
    include: 'scripts/installer.nsh',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    icon: 'assets/icon.icns',
    category: 'public.app-category.productivity',
    artifactName: PRODUCT_NAME + '-${version}-macOS-${arch}.${ext}',
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    mergeASARs: true,
    extendInfo: {
      CFBundleDocumentTypes: [{
        CFBundleTypeName: 'Markdown document',
        CFBundleTypeRole: 'Editor',
        LSHandlerRank: 'Alternate',
        CFBundleTypeExtensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt'],
      }],
    },
  },
  dmg: {
    title: PRODUCT_NAME + ' ${version}',
    format: 'UDZO',
    background: 'assets/installer-background.png',
    window: { width: 540, height: 380 },
    iconSize: 96,
    iconTextSize: 14,
    contents: [
      { x: 130, y: 200, type: 'file' },
      { x: 410, y: 200, type: 'link', path: '/Applications' },
    ],
  },
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateAbsolutePath } = require('./file-store.cjs');

// These are compatibility identifiers, independent of the public product name.
const APP_ID = 'io.moye.editor';
const PROFILE_NAME = 'Moye';
const UPDATE_PREFIX = 'Moye';
const REPOSITORY = 'Irk2wd/Meki';
const LEGACY_REPOSITORY = 'Irk2wd/moye';
const PRODUCT_NAME = require('../package.json').productName;
// Keep Windows OpenWith registration and installed executable paths compatible.
const WINDOWS_EXECUTABLE = 'Moye';

function installerName(version, platform) {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version) || !['win32', 'darwin'].includes(platform)) throw new Error('Invalid installer target.');
  return `${PRODUCT_NAME}-${version}-${platform === 'win32' ? 'Setup-x64.exe' : 'macOS-universal.dmg'}`;
}

function configureApp(app, { productName = require('../package.json').productName, userData = process.env.MOYE_USER_DATA } = {}) {
  const folder = validateAbsolutePath(userData || path.join(app.getPath('appData'), PROFILE_NAME));
  fs.mkdirSync(folder, { recursive: true });
  app.setName(productName);
  app.setPath('userData', folder);
  app.setAppUserModelId(APP_ID);
}

module.exports = { APP_ID, PROFILE_NAME, UPDATE_PREFIX, REPOSITORY, LEGACY_REPOSITORY, PRODUCT_NAME, WINDOWS_EXECUTABLE, installerName, configureApp };

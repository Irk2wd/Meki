'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateAbsolutePath } = require('./file-store.cjs');

const APP_ID = 'io.meki.editor';
const PROFILE_NAME = 'Meki';
const UPDATE_PREFIX = 'Meki';
const REPOSITORY = 'Irk2wd/Meki';
const PRODUCT_NAME = require('../package.json').productName;
const WINDOWS_EXECUTABLE = 'Meki';

function installerName(version, platform) {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version) || !['win32', 'darwin'].includes(platform)) throw new Error('Invalid installer target.');
  return `${PRODUCT_NAME}-${version}-${platform === 'win32' ? 'Setup-x64.exe' : 'macOS-universal.dmg'}`;
}

function configureApp(app, { productName = require('../package.json').productName, userData = process.env.MEKI_USER_DATA } = {}) {
  const folder = validateAbsolutePath(userData || path.join(app.getPath('appData'), PROFILE_NAME));
  fs.mkdirSync(folder, { recursive: true });
  app.setName(productName);
  app.setPath('userData', folder);
  app.setAppUserModelId(APP_ID);
}

module.exports = { APP_ID, PROFILE_NAME, UPDATE_PREFIX, REPOSITORY, PRODUCT_NAME, WINDOWS_EXECUTABLE, installerName, configureApp };

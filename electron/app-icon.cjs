'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./update-policy.cjs');

function nativeIconName(platform) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Unsupported application icon platform.');
  return platform === 'darwin' ? 'icon.icns' : 'icon.ico';
}
function nativeIconHash(directory, platform) {
  return digest(fs.readFileSync(path.join(directory, 'assets', nativeIconName(platform))));
}
function syncDockIcon(app) {
  app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
}
module.exports = { nativeIconName, nativeIconHash, syncDockIcon };

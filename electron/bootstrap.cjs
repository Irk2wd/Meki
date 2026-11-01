'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { UpdateRuntime } = require('./update-runtime.cjs');
const { configureApp } = require('./app-identity.cjs');
const base = path.resolve(__dirname, '..');
configureApp(app);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const test = process.env.MEKI_TEST === '1' && Boolean(process.env.MEKI_USER_DATA);
  const key = test && process.env.MEKI_TEST_UPDATE_KEY ? fs.readFileSync(process.env.MEKI_TEST_UPDATE_KEY, 'utf8') : require('./update-key.cjs');
  let runtime, archive;
  try {
    runtime = new UpdateRuntime({ userData: app.getPath('userData'), baseVersion: require('../package.json').version,
      electron: process.versions.electron, platform: process.platform, arch: process.arch, key });
    archive = runtime.selectStartup();
  } catch { runtime = null; archive = null; console.warn('Meki update cache is unavailable; starting the installed application.'); }
  globalThis[Symbol.for('meki.bootstrap')] = { runtime, hasLock: true };
  try { require(path.join(archive || base, 'electron', 'main.cjs')); }
  catch (error) {
    if (archive && !test) app.relaunch();
    console.error('Meki startup failed:', error.message); app.exit(1);
  }
}

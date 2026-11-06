'use strict';
const { FileStore } = require('../electron/file-store.cjs');
const { LifecycleStore } = require('../electron/lifecycle-store.cjs');
const { WindowSessions } = require('../electron/window-sessions.cjs');

// Read the durable catalog and bodies without running startup, cleanup or restoration.
async function readWindows(profile) {
  const store = new FileStore(profile), history = new LifecycleStore(store);
  for (let attempt = 0; ; attempt++) {
    const windows = new WindowSessions(store, history);
    await windows.init();
    if (!windows.corrupt) return windows.records;
    // A running application may replace the catalog and prune its old body while
    // this independent test reader is loading it. Retry against the new catalog.
    if (attempt === 4) throw Error(windows.warning);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function readSession(profile) {
  const records = await readWindows(profile);
  return (records.find(record => record.id === 'main') || records[0])?.session || null;
}
module.exports = { readWindows, readSession };

'use strict';
const { FileStore } = require('../electron/file-store.cjs');
const { LifecycleStore } = require('../electron/lifecycle-store.cjs');
const { WindowSessions } = require('../electron/window-sessions.cjs');

// Read the durable catalog and bodies without running startup, cleanup or restoration.
async function readWindows(profile) {
  const store = new FileStore(profile), history = new LifecycleStore(store);
  for (let attempt = 0; ; attempt++) {
    const windows = new WindowSessions(store, history);
    // The running app can replace the catalog during its first stat or prune
    // an old body during the read. Each attempt checks the whole snapshot.
    try {
      await windows.init();
      if (windows.corrupt) throw new Error(windows.warning);
      return windows.records;
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function readSession(profile) {
  const records = await readWindows(profile);
  return (records.find(record => record.id === 'main') || records[0])?.session || null;
}
module.exports = { readWindows, readSession };

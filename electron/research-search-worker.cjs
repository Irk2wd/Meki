'use strict';

const { ResearchStore } = require('./research-store.cjs');
const { searchProject } = require('./research-search.cjs');
let queue = Promise.resolve();
process.parentPort.on('message', ({ data: { id, root, input } }) => {
  queue = queue.then(async () => {
    try {
      const store = await ResearchStore.open(root);
      if (!store) throw new Error('Research project is unavailable.');
      process.parentPort.postMessage({ id, result: await searchProject(store, input) });
    } catch (error) { process.parentPort.postMessage({ id, error: error.message }); }
  });
});

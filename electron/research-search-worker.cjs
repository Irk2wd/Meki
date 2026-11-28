'use strict';

const { ResearchStore } = require('./research-store.cjs');
const { searchProject } = require('./research-search.cjs');
const { projectFromSnapshot } = require('./research-subscribed-project.cjs');
let queue = Promise.resolve();
const active = new Map();
process.parentPort.on('message', ({ data: { id, root, input, kind, config, key, preview } }) => {
  const open = () => preview ? projectFromSnapshot(root, preview) : ResearchStore.open(root);
  if (kind === 'cancel') { active.get(id)?.abort(); return; }
  if (kind === 'smart') {
    const controller = new AbortController(); active.set(id,controller);
    void (async () => {
      try {
        const store = await open();
        if (!store) throw Error('Research project is unavailable.');
        const result = await require('./research-smart-search.cjs').smartSearch(store,input,config,key,{
          signal:controller.signal,onProgress:(progress,preview)=>process.parentPort.postMessage({id,progress,preview})});
        process.parentPort.postMessage({id,result});
      } catch(e) {process.parentPort.postMessage({id,error:e.message});}
      finally {active.delete(id);}
    })();
    return;
  }
  queue = queue.then(async () => {
    try {
      const store = await open();
      if (!store) throw new Error('Research project is unavailable.');
      process.parentPort.postMessage({ id, result: await searchProject(store, input) });
    } catch (error) { process.parentPort.postMessage({ id, error: error.message }); }
  });
});

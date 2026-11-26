'use strict';

const path = require('node:path');
const { app, utilityProcess } = require('electron');
let worker, sequence = 0;
const requests = new Map();

function start() {
  const child = utilityProcess.fork(path.join(__dirname, 'research-search-worker.cjs'), [], { serviceName: 'mekiR project search' });
  child.on('message', ({ id, result, error }) => {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    if (error) request.reject(new Error(error)); else request.resolve(result);
  });
  child.once('exit', () => {
    if (worker !== child) return;
    worker = undefined;
    for (const { reject } of requests.values()) reject(new Error('The research search process closed.'));
    requests.clear();
  });
  return child;
}
app.once('will-quit', () => worker?.kill());
function search(root, input) {
  worker ??= start();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    try { worker.postMessage({ id, root, input }); }
    catch (error) { requests.delete(id); reject(error); }
  });
}
module.exports = { search };

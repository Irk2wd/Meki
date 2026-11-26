'use strict';

const path = require('node:path');
const { app, utilityProcess } = require('electron');
let worker, sequence = 0;
const requests = new Map();

function start() {
  const child = utilityProcess.fork(path.join(__dirname, 'research-search-worker.cjs'), [], { serviceName: 'mekiR project search' });
  child.on('message', ({ id, result, error, progress, preview }) => {
    const request = requests.get(id);
    if (!request) return;
    if (progress) { request.progress?.(progress,preview); return; }
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
function dispatch(payload, token, progress) {
  worker ??= start();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject, token, progress });
    try { worker.postMessage({ id, ...payload }); }
    catch (error) { requests.delete(id); reject(error); }
  });
}
function search(root,input) { return dispatch({root,input}); }
function smart(root,input,config,key,token,progress) { return dispatch({root,input,config,key,kind:'smart'},token,progress); }
function cancel(token) {
  for(const [id,request] of requests) if(request.token===token) worker?.postMessage({id,kind:'cancel'});
}
module.exports = { search, smart, cancel };

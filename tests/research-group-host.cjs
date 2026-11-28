'use strict';

const http = require('node:http');
const {once} = require('node:events');
const {digest} = require('../electron/file-store.cjs');

async function groupHost() {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlqIpUAAAAASUVORK5CYII=', 'base64');
  const projects = [{id:'forest',title:'森林树冠',directory:'trees'},{id:'trail',title:'步道机位',directory:'camera'}];
  const catalog = {format:'mekir-subscriptions/1', library:{id:'library',title:'研究库'},
    groups:[{id:'render',title:'渲染组',projects:['forest','trail']},{id:'graphics',title:'图形组',projects:['forest']}],projects};
  const calls = [], files = new Map(), state = {catalog, catalogStatus:200};
  for (const p of projects) {
    const image = digest(pixel), format = 'mekir-preview/1';
    const bytes = Buffer.from(JSON.stringify({format,asOf:'2026-11-17',project:{id:p.id,title:p.title,description:'计时研究',phaseGoals:'hidden'},phases:[
      {id:'timing',title:'计时复测',description:'',start:'2026-11-15',end:null,records:1,days:[{date:'2026-11-17',records:1,trials:0}],goals:[]}],
      items:[{id:'compare',kind:'comparison',label:'对比',title:'树冠对比',text:'同机位。',date:'2026-11-17',phases:['timing'],
        figure:{columns:['树冠'],rows:[{label:'步道',images:[image]}]}}]}));
    const rev = digest(bytes), base = '/' + p.directory + '/';
    files.set(base+'latest.json',Buffer.from(JSON.stringify({format,projectId:p.id,revision:rev,publishedAt:'2026-11-17T10:00:00Z'})));
    files.set(base+'snapshots/'+rev+'.json',bytes);
    files.set(base+'media/'+image+'.png',pixel);
  }
  const server = http.createServer((req,res) => {
    calls.push(req.url);
    const send = (status, data) => { res.writeHead(status); res.end(data); };
    const auth = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
    if (auth !== 'member:test-only' || req.method !== 'GET') return send(401);
    if (req.url === '/_mekir/accounts/member.json') return send(state.catalogStatus,JSON.stringify(state.catalog));
    if (!state.catalog.projects.some(p => req.url.startsWith('/'+p.directory+'/'))) return send(403);
    return send(files.has(req.url) ? 200 : 404, files.get(req.url));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {url:'http://127.0.0.1:' + server.address().port + '/', state, calls, files,
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }};
}
module.exports = { groupHost };

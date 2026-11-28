'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {once} = require('node:events');
const {projectPreview, validateSnapshot} = require('../electron/research-preview-model.cjs');
const {PreviewDAV, endpoint} = require('../electron/research-preview-dav.cjs');
const {PreviewService} = require('../electron/research-preview-service.cjs');
const {digest} = require('../electron/file-store.cjs');
const {ResearchStore} = require('../electron/research-store.cjs');

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlqIpUAAAAASUVORK5CYII=', 'base64');
const phase = {id:'canopy',title:'Canopy',start:'2024-01-01',goals:[{text:'Compare cameras'}]};
const experiment = {id:'tune',label:'Tuning',kind:'entry',fields:[],template:'{{title}}'};
const summary = {id:'review',label:'Review',kind:'summary',fields:[],template:'{{title}}'};
const meta = {version:1,id:'forest',title:'Forest',timezone:'UTC',phases:[phase],recordTypes:[experiment,summary],
  views:[{id:'axis',label:'Timeline',layout:'timeline',order:'newest'}],defaultView:'axis'};
const record = {id:'canopy-run',type:'tune',title:'Tuning',phaseId:'canopy',date:'2024-02-02',fields:{}};

async function davServer(t) {
  const files = new Map(), calls = [];
  const state = {failedMove:false};
  const server = http.createServer(async(req,res)=>{
    const name = new URL(req.url,'http://localhost').pathname;
    const method = req.method, body = [];
    for await (const chunk of req) body.push(chunk);
    const bytes = Buffer.concat(body);
    calls.push([method,name]);
    const send = (status,content,headers={}) => {res.writeHead(status,headers);res.end(content);};
    const auth = Buffer.from((req.headers.authorization || '').split(' ')[1] || '','base64').toString();
    if (!['writer:one','reader:two'].includes(auth)) return send(401);
    if (!['GET','HEAD'].includes(method) && auth !== 'writer:one') return send(403);
    if (method === 'PUT') {files.set(name,bytes);return send(201);}
    if (method === 'MKCOL') return send(405);
    if (!files.has(name)) return send(404);
    if (method === 'DELETE') {files.delete(name);return send(204);}
    if (method === 'MOVE') {
      if(state.failedMove) return send(503);
      const dest = new URL(req.headers.destination).pathname;
      if (files.has(dest) && req.headers.overwrite === 'F') return send(412);
      files.set(dest,files.get(name));files.delete(name);return send(201);
    }
    const value = files.get(name);
    send(200,method === 'HEAD' ? undefined : value,{'Content-Length':value.length,ETag:`"${digest(value)}"`});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return {url:`http://127.0.0.1:${server.address().port}/`,files,calls,state};
}

test('preview projects daily activity, confirmed findings and custom events without publishing the archive',async()=>{
  const privateField = '/Users/private/archive/log.csv';
  const entry = {record:{...record,fields:{secret:privateField}}, excerpt:'Faster on trail.',trials:[{id:'private-trial',date:'2024-02-03'},{id:'another',date:'2024-02-03'}]};
  const store = {snapshot:async()=>({root:privateField,project:{...meta,phaseGoals:'hidden',evidenceSources:[{id:'private-source'}],
    recordTypes:[experiment,summary,{id:'meeting',kind:'event',icon:'people',label:'Group meeting'}]}, records:[
    entry,{record:{...record,id:'obsolete',tier:'log',date:'2024-02-05'},excerpt:'Log only.'},
    {record:{...record,id:'second',type:'review',coverage:{start:'2024-02-01',end:'2024-02-04'},date:'2024-02-03'},excerpt:'Confirmed baseline.'},
    {record:{...record,id:'slides',type:'meeting'}},{record:{...record,id:'fig',comparison:{columns:['a','b'],rows:[{label:'camera',images:['absolute-file',null]}]}}}
  ],comparisonType:{id:'figure',kind:'comparison'},problems:[]}),read:async id=>({body:id==='fig'?'Caption.':'Full selected report.'})};
  const b=await projectPreview(store,[],async()=>pixel);
  const s=b.snapshot, p=s.phases[0];assert.equal(p.records,2);assert.deepEqual(p.goals,[]);assert.equal(p.finding.text,'Confirmed baseline.');
  assert.deepEqual(p.days.find(d=>d.date==='2024-02-03'),{date:'2024-02-03',records:1,trials:2});
  assert.equal(s.items.find(i=>i.id==='slides').icon,'people');
  assert.deepEqual(s.items.find(i=>i.id==='fig').figure.rows[0].images,[digest(pixel),null]);
  for (const hidden of [privateField,'private-trial','private-source','absolute-file','Full selected report.','canopy-run','Log only.']) assert.ok(!b.bytes.includes(hidden));
  const selected=await projectPreview(store,['canopy-run'],async()=>pixel);
  assert.equal(selected.snapshot.items.find(i=>i.id==='canopy-run').body,'Full selected report.');
  const invalid=structuredClone(s);invalid.items.find(i=>i.figure).figure.rows[0].images[0]='../../outside';
  assert.throws(()=>validateSnapshot(invalid,meta.id),/figure/);
});

test('WebDAV commits a complete version last, checks hashes, repairs cache and rebinds subscriptions by stable project ID', async t=>{
  const host=await davServer(t), other=await davServer(t);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mekir-preview-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const credentials={seal:async v=>Buffer.from(v).toString('base64'),open:async v=>Buffer.from(v,'base64').toString()};
  const service=await new PreviewService(dir,{credentials}).init();
  const media=new Map([[digest(pixel),pixel]]);
  const shape={format:'mekir-preview/1',asOf:'2024-02-04',project:{id:'forest',title:'Forest',description:'',phaseGoals:'list'},phases:[],
    items:[{id:'fig',phases:[],title:'Canopy',date:'2024-02-04',kind:'comparison',label:'Frame',text:'',figure:{columns:['A'],rows:[{label:'A',images:[digest(pixel)]}]}}]};
  function build(title) {const snapshot=structuredClone(shape);snapshot.project.title=title;const bytes=Buffer.from(JSON.stringify(snapshot));return {snapshot,bytes,revision:digest(bytes),media};}
  const writer=new PreviewDAV(host.url,'writer','one'), login={url:host.url,username:'reader',password:'two'};
  const a=await writer.publish(build('First'));
  const [sub,duplicate]=await Promise.all([service.subscribe(login),service.subscribe(login)]);
  assert.equal(sub.id,duplicate.id);
  const cached=await service.cached(sub.id);
  assert.equal(cached.pointer.revision,a.revision);assert.ok((await service.image(sub.id,digest(pixel))).startsWith('data:image/png'));
  assert.equal(sub.secret,undefined);assert.equal(sub.password,undefined);
  await assert.rejects(async()=>new PreviewDAV(host.url,'reader','two').publish(build('reader')),/HTTP 403/);
  host.state.failedMove=true;
  await assert.rejects(writer.publish(build('Next')),/HTTP 503/);
  assert.equal((await service.refresh(sub.id)).snapshot.project.title,'First');
  host.state.failedMove=false;await writer.publish(build('Next'));
  assert.equal(host.calls.filter(([method,name])=>method==='PUT'&&name.includes('/media/')).length,1);
  const current=JSON.parse(host.files.get('/latest.json')); const manifest='/snapshots/'+current.revision+'.json';
  const good=host.files.get(manifest);host.files.set(manifest,Buffer.from('damaged'));
  await assert.rejects(service.refresh(sub.id),/校验失败/);assert.equal((await service.cached(sub.id)).snapshot.project.title,'First');
  host.files.set(manifest,good);await service.refresh(sub.id);
  await fs.unlink(path.join(dir,sub.id,digest(pixel)+'.thumb'));await service.refresh(sub.id);assert.ok(await service.image(sub.id,digest(pixel)));
  for (const [name,value] of host.files) other.files.set(name,value);
  await assert.rejects(service.subscribe({...login,url:other.url,password:undefined},sub.id),/密码/);
  const moved=await service.subscribe({...login,url:other.url},sub.id);assert.equal(moved.id,sub.id);assert.equal(moved.projectId,'forest');
  other.files.set('/latest.json',Buffer.from(JSON.stringify({...current,projectId:'wrong'})));await assert.rejects(service.refresh(sub.id),/不匹配/);
  assert.equal((await service.cached(sub.id)).snapshot.project.title,'Next');assert.equal(service.readers().length,1);
  const reopened=await new PreviewService(dir,{credentials}).init();assert.equal((await reopened.cached(sub.id)).pointer.revision,current.revision);
  await reopened.remove(sub.id);assert.deepEqual(reopened.readers(),[]);
  assert.throws(()=>endpoint('http://host.example/preview/'),/HTTPS/);assert.throws(()=>endpoint('https://admin:example@host.example/'),/HTTPS/);
});

test('an external agent batch is picked up automatically and unchanged records do not republish',async t=>{
  const host=await davServer(t);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mekir-preview-publish-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=await ResearchStore.initialize(path.join(dir,'project'),meta,[{...record,body:'A private experiment body.'}]);
  const service=await new PreviewService(path.join(dir,'device'),{credentials:{seal:async v=>v,open:async v=>v}}).init();
  await service.configurePublisher(store,{url:host.url,username:'writer',password:'one',auto:true});
  const original=JSON.parse(host.files.get('/latest.json'));const calls=host.calls.length;
  await service.tick();assert.equal(host.calls.length,calls);
  const external=await ResearchStore.open(store.root);await external.writeBatch({records:[{id:'next-run',type:'tune',phaseId:'canopy',date:'2024-02-04',title:'Repeat',fields:{},body:'## 结论\n\nLower frame time.'}]});
  await service.tick();const current=JSON.parse(host.files.get('/latest.json'));assert.notEqual(current.revision,original.revision);
  assert.equal(current.previous,original.revision);assert.equal(JSON.parse(host.files.get('/snapshots/'+current.revision+'.json')).phases[0].records,2);
  await service.pause(store.root);await external.writeBatch({records:[{id:'next-run',ifRevision:(await external.read('next-run')).revision,title:'Follow-up'}]});await service.tick();assert.deepEqual(JSON.parse(host.files.get('/latest.json')),current);
});

test('a subscribed workspace exposes published text, custom views and phase totals without local file capabilities', async () => {
  const {projectFromSnapshot} = require('../electron/research-subscribed-project.cjs');
  const shared = {...record, id:'shared', title:'Trail baseline'};
  const store = {snapshot:async()=>({project:meta,comparisonType:{id:'figure',kind:'comparison',label:'Figure'},problems:[],
    records:[{record:shared,excerpt:'Baseline measured.',trials:[{id:'private-trial',date:'2024-02-04'}]},
      {record:{...record,id:'internal',date:'2024-02-05'},excerpt:'Replicated.'}]}),read:async()=>({body:'Trail timings.'})};
  const built = await projectPreview(store,['shared'],async()=>pixel);
  const pointer = {projectId:meta.id,revision:built.revision,publishedAt:'2024-02-05T12:00:00Z'};
  const project = projectFromSnapshot('subscription:test',{pointer,snapshot:built.snapshot},()=>assert.fail('unindexed image access'));
  const state = project.snapshot({query:'timings'});
  assert.equal(state.project.defaultView,'axis');
  assert.deepEqual(state.project.views, built.snapshot.project.views);
  assert.deepEqual(state.matchingIds,['shared']);
  assert.equal(state.subscription.phases.canopy.records,2);
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].trials[0].date,'2024-02-04');
  assert.equal(project.read('shared').body,'Trail timings.');
  assert.throws(()=>project.read('internal'));
  await assert.rejects(project.image(digest(pixel)));
  assert.equal(project.writeBatch,undefined);
  assert.equal(project.evidenceFile,undefined);
});

'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createExampleProject}=require('../electron/research-example.cjs');
const {Evidence,safeText}=require('../electron/research-ai-evidence.cjs');
const {smartSearch,validateAnswer}=require('../electron/research-smart-search.cjs');
const {config,save,settings}=require('../electron/research-ai-settings.cjs');
const provider=require('../electron/research-ai-provider.cjs');
const http=require('node:http');
test('Codex resolves a Windows npm shim without executing a command shell',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mekir-codex-shim-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const shim=path.join(root,'codex.cmd'),entry=path.join(root,'node_modules','@openai','codex','bin','codex.js'),node=path.join(root,'node.exe');
  await fs.mkdir(path.dirname(entry),{recursive:true});
  await Promise.all([shim,entry,node].map(f=>fs.writeFile(f,'')));
  assert.deepEqual(await provider.codexCommand('',{PATH:root},'win32'),{executable:node,prefix:[entry]});
  assert.deepEqual(await provider.codexCommand(shim,{PATH:root},'win32'),{executable:node,prefix:[entry]});
});
test('smart search resolves source IDs, tool output and explicit gaps for external agents',async t=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'mekir-smart-test-')), previous=process.env.MEKIR_LOCAL_STATE;
  process.env.MEKIR_LOCAL_STATE=tmp;
  t.after(async()=>{if(previous===undefined)delete process.env.MEKIR_LOCAL_STATE;else process.env.MEKIR_LOCAL_STATE=previous;await fs.rm(tmp,{force:true,recursive:true});});
  const store=await createExampleProject(path.join(tmp,'project'));
  const cfg=await save(store,{provider:'compatible',protocol:'chat',base:'http://127.0.0.1:8877/v1',model:'test'});
  assert.throws(()=>config({...cfg,base:'http://insecure.example'}));
  const configDir=path.join(tmp,'smart-search','projects'), [filename]=await fs.readdir(configDir);
  await fs.writeFile(path.join(configDir,filename),JSON.stringify({...cfg,allowRecords:false,sourceIds:[]}));
  assert.deepEqual((await settings(store)).value,cfg);
  const directory=path.join(tmp,'later-source');
  await fs.mkdir(directory); await fs.writeFile(path.join(directory,'later.md'),'补录的对照结果');
  await store.bindEvidenceSource('later',directory,'后续登记的来源');
  await store.indexEvidence('later-report',{sourceId:'later',relativePath:'later.md',title:'后续复测'});
  const state=await store.snapshot(), e=new Evidence(store,state,{query:'基线'});
  assert.ok((await e.read(e.ref('forest-timings'))).rows>0);
  assert.match((await e.read(e.ref('later-report'))).context[0].text,/补录的对照结果/);
  assert.equal(e.ref('unregistered'),undefined);
  assert.equal(new Evidence(store,state,{phase:'exploration'}).ref('forest-validation'),undefined);
  assert.equal(safeText('See /Users/example/data.csv'),'See [local path]');
  const id=e.ref('tile-culling'),read=await e.read(id);
  assert.ok(read.trials.some(r=>r.trial==='baseline-repeat'));
  const proof=read.context[0],answer={claims:[{text:'这条轨迹有遮挡剔除复测。',proofs:[{ref:proof.ref,quote:proof.text.slice(0,8)}]}],tables:[id],gaps:[]};
  assert.ok(validateAnswer(e,answer).tables[0].rows.length);
  assert.throws(()=>validateAnswer(e,{...answer,claims:[{text:'Measured 9999 ms.',proofs:answer.claims[0].proofs}]}));
  assert.throws(()=>validateAnswer(e,{...answer,claims:[{text:'test',proofs:[{ref:'E999',quote:'fabricated'}]}]}));
  const local=await smartSearch(store,{query:'baseline-repeat'},null);
  assert.equal(local.status,'local');assert.equal(local.reason,'not-configured');assert.ok(local.results.length);
});
test('provider adapters round-trip read-only calls and tool results without a cloud account',async t=>{
  const previous=process.env.NO_PROXY;process.env.NO_PROXY='127.0.0.1,localhost';
  t.after(()=>{if(previous===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=previous;});
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;const body=text&&JSON.parse(text);
    let data;
    if(req.url.endsWith('/models'))data={data:[{id:'test'}]};
    else if(req.url.endsWith('/responses')){assert.equal(body.store,false);data={output:[{type:'function_call',call_id:'c',name:'read_evidence',arguments:'{"ref":"E1"}'}]};}
    else if(req.url.endsWith('/completions'))data={choices:[{message:{role:'assistant',tool_calls:[{id:'c',type:'function',function:{name:'read_evidence',arguments:'{"ref":"E1"}'}}]}}]};
    else if(req.url.endsWith('/messages'))data={content:[{type:'tool_use',id:'c',name:'read_evidence',input:{ref:'E1'}}]};
    else data={candidates:[{content:{role:'model',parts:[{functionCall:{id:'c',name:'read_evidence',args:{ref:'E1'}}}]}}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(r=>server.close(r)));
  const tools=[{name:'read_evidence',description:'Read',parameters:{type:'object',properties:{ref:{type:'string'}}}}];
  for(const protocol of ['responses','chat','messages','gemini']){
    const cfg={protocol,provider:'compatible',base:'http://127.0.0.1:'+server.address().port,model:'test'};
    const first=await provider.turn(cfg,'test','rules','q',tools,[],false);
    assert.deepEqual(first.calls[0].args,{ref:'E1'});
    const second=await provider.turn(cfg,'test','rules','q',tools,[{...first,results:[{...first.calls[0],data:'original text'}]}],false);
    assert.equal(second.calls[0].name,'read_evidence');
  }
});

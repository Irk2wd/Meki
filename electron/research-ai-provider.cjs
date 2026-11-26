'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');

function headers(config,key) {
  const h={'Content-Type':'application/json'};
  if(config.protocol==='messages') { h['anthropic-version']='2023-06-01'; if(key) h['x-api-key']=key; }
  else if(config.protocol==='gemini') { if(key) h['x-goog-api-key']=key; }
  else if(key) h.Authorization='Bearer '+key;
  return h;
}
async function request(config,key,suffix,body,signal) {
  if(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) require('node:http').setGlobalProxyFromEnv?.();
  const timed=AbortSignal.timeout(90000);
  const response=await fetch(config.base+suffix,{method:body?'POST':'GET', headers:headers(config,key),
    redirect:'error', signal:signal?AbortSignal.any([signal,timed]):timed, ...(body && {body:JSON.stringify(body)})});
  if(!response.ok) { await response.body?.cancel(); throw new Error('Model API returned HTTP '+response.status+'.'); }
  let length=0; const pieces=[];
  for await(const part of response.body) {
    length+=part.length;if(length>4*1024*1024)throw Error('Model response exceeded the size limit.');
    pieces.push(part);
  }
  return JSON.parse(Buffer.concat(pieces).toString('utf8'));
}
async function listModels(config,key,signal) {
  if(config.protocol==='codex')return [];
  const data=await request(config,key,'/models',null,signal);
  const ids=config.protocol==='gemini' ? (data.models||[]).filter(m=>!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m=>m.name?.replace(/^models\//,''))
    : (data.data||[]).map(m=>m.id);
  return [...new Set(ids.filter(id=>typeof id==='string' && id.length<=180))].sort();
}
const argumentsOf = value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return {}; }};
const callsOf = (items,decode)=>items.map(decode).map((c,i)=>({...c,id:c.id||String(i),args:argumentsOf(c.args)}));
function answerText(text) {
  if(typeof text!=='string')return [];
  try {const d=JSON.parse(text.replace(/^\\s*\x60{3}(?:json)?|\x60{3}\\s*$/g,'').trim());
    if(Array.isArray(d.claims))return [{name:'finish',id:'final',args:d}];
  }catch{}
  return [];
}

async function turn(config,key,instructions,question,tools,history,final,signal) {
  if(config.protocol==='codex')return codexTurn(config,instructions,question,tools,history,final,signal);
  const model=config.model, active=final?tools.filter(t=>t.name==='finish'):tools;
  const suffix=config.protocol==='responses'?'/responses':config.protocol==='chat'?'/chat/completions':config.protocol==='messages'?'/messages':
    '/models/'+encodeURIComponent(model.replace(/^models\//,''))+':generateContent';
  let body;
  if(config.protocol==='responses'){
    const input=[{role:'user',content:question}];
    for(const h of history)input.push(...h.raw,...h.results.map(r=>({type:'function_call_output',call_id:r.id,output:JSON.stringify(r.data)})));
    body={model,instructions,input,store:false,tools:active.map(t=>({type:'function',...t,strict:false})),
      ...(config.provider==='openai' && {include:['reasoning.encrypted_content']}),max_output_tokens:3600};
  }else if(config.protocol==='chat'){
    const messages=[{role:'system',content:instructions},{role:'user',content:question}];
    for(const h of history)messages.push(h.raw,...h.results.map(r=>({role:'tool',tool_call_id:r.id,content:JSON.stringify(r.data)})));
    body={model,messages,tools:active.map(t=>({type:'function',function:t})),tool_choice:'auto',
      ...(config.base.startsWith('https://api.openai.com/')?{max_completion_tokens:3600}:{max_tokens:3600})};
  }else if(config.protocol==='messages'){
    const messages=[{role:'user',content:question}];
    for(const h of history)messages.push({role:'assistant',content:h.raw},{role:'user',content:h.results.map(r=>({type:'tool_result',tool_use_id:r.id,content:JSON.stringify(r.data)}))});
    body={model,system:instructions,messages,max_tokens:3000,tools:active.map(t=>({name:t.name,description:t.description,input_schema:t.parameters}))};
  }else{
    const contents=[{role:'user',parts:[{text:question}]}];
    for(const h of history) contents.push(h.raw,{role:'user',parts:h.results.map(r=>({functionResponse:{name:r.name,response:{data:r.data},...(r.nativeId && {id:r.nativeId})}}))});
    body={systemInstruction:{parts:[{text:instructions}]},contents,generationConfig:{maxOutputTokens:3600},
      tools:[{functionDeclarations:active.map(t=>({name:t.name,description:t.description,parametersJsonSchema:t.parameters}))}]};
  }
  const result=await request(config,key,suffix,body,signal);
  let raw,calls,text,usage;
  if(config.protocol==='responses'){
    raw=result.output||[]; calls=callsOf(raw.filter(i=>i.type==='function_call'),i=>({id:i.call_id,name:i.name,args:i.arguments}));
    text=raw.flatMap(i=>i.content||[]).map(i=>i.text||'').join('');usage=result.usage?.total_tokens;
  }else if(config.protocol==='chat'){
    raw=result.choices?.[0]?.message || {};calls=callsOf(raw.tool_calls||[],i=>({id:i.id,name:i.function.name,args:i.function.arguments}));text=raw.content;usage=result.usage?.total_tokens;
  }else if(config.protocol==='messages'){
    raw=result.content||[];calls=callsOf(raw.filter(i=>i.type==='tool_use'),i=>({id:i.id,name:i.name,args:i.input}));
    text=raw.filter(i=>i.type==='text').map(i=>i.text).join(''); usage=(result.usage?.input_tokens||0)+(result.usage?.output_tokens||0);
  }else{
    raw=result.candidates?.[0]?.content||{role:'model',parts:[]}; calls=callsOf(raw.parts.filter(i=>i.functionCall),i=>({id:i.functionCall.id,nativeId:i.functionCall.id,name:i.functionCall.name,args:i.functionCall.args}));
    text=raw.parts.filter(i=>!i.thought).map(i=>i.text||'').join('');usage=result.usageMetadata?.totalTokenCount;
  }
  return {raw,calls:calls.length?calls:answerText(text),usage:Number(usage)||0};
}

async function codexTurn(config,instructions,question,tools,history,final,signal) {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mekir-model-'));
  const output=path.join(temp,'answer.json'), schema=path.join(temp,'schema.json');
  const active=final?tools.filter(t=>t.name==='finish'):tools;
  const format={type:'object',properties:{actions:{type:'array',items:{type:'object',properties:{
    name:{type:'string',enum:active.map(t=>t.name)},arguments:{type:'string'}},required:['name','arguments'],additionalProperties:false}}},
    required:['actions'],additionalProperties:false};
  const prompt=[instructions,'The app executes the tools. Return actions with arguments encoded as a JSON string. Tools:',
    JSON.stringify(active),question,...history.map(h=>JSON.stringify({calls:h.calls,results:h.results})),final?'Return finish now.':''].join('\n');
  try{
    await fs.writeFile(schema,JSON.stringify(format));
    const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
      '--disable','shell_tool','--disable','unified_exec','--disable','multi_agent','--disable','computer_use','--disable','plugins',
      '-c','web_search="disabled"','-c','approval_policy="never"','-c','model_reasoning_effort="low"',
      '--output-schema',schema,'-o',output,...(config.model?['-m',config.model]:[]),'-'];
    const executable=config.cliPath||'codex';
    const childEnv={...process.env};
    if(config.cliPath) childEnv.PATH=path.dirname(config.cliPath)+path.delimiter+(childEnv.PATH||'');
    const timed=AbortSignal.timeout(120000);
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:temp,env:childEnv,windowsHide:true,stdio:['pipe','ignore','ignore'],
        signal:signal?AbortSignal.any([signal,timed]):timed});
      child.on('error',reject);child.stdin.on('error',()=>{});child.stdin.end(prompt);
      child.on('close',code=>code===0?resolve():reject(Error('Codex CLI exited with code '+code+'. Check the login and executable in model settings.')));
    });
    const message=JSON.parse(await fs.readFile(output,'utf8'));
    if(!Array.isArray(message.actions))throw Error('Codex returned an invalid tool response.');
    const calls=callsOf(message.actions.slice(0,8),a=>({name:a.name,args:a.arguments}));
    return {raw:[],calls,usage:0};
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
module.exports={turn,listModels};

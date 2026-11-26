'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicWrite, digest, pathKey } = require('./file-store.cjs');
const { assert } = require('./research-model.cjs');

const presets = [
  {id:'openai',name:'OpenAI',protocol:'responses',base:'https://api.openai.com/v1',env:'OPENAI_API_KEY'},
  {id:'deepseek',name:'DeepSeek',protocol:'responses',base:'https://api.deepseek.com',env:'DEEPSEEK_API_KEY'},
  {id:'anthropic',name:'Anthropic Claude',protocol:'messages',base:'https://api.anthropic.com/v1',env:'ANTHROPIC_API_KEY'},
  {id:'gemini',name:'Google Gemini',protocol:'gemini',base:'https://generativelanguage.googleapis.com/v1beta',env:'GEMINI_API_KEY'},
  {id:'qwen',name:'Qwen · DashScope',protocol:'chat',base:'https://dashscope.aliyuncs.com/compatible-mode/v1',env:'DASHSCOPE_API_KEY'},
  {id:'moonshot',name:'Kimi · Moonshot',protocol:'chat',base:'https://api.moonshot.cn/v1',env:'MOONSHOT_API_KEY'},
  {id:'openrouter',name:'OpenRouter',protocol:'chat',base:'https://openrouter.ai/api/v1',env:'OPENROUTER_API_KEY'},
  {id:'compatible',name:'OpenAI compatible',protocol:'chat',base:'',env:'MEKIR_AI_API_KEY'},
  {id:'codex',name:'OpenAI · Codex CLI',protocol:'codex',base:'',env:''},
];
const protocols = ['responses','chat','messages','gemini','codex'];
const configDir = () => path.join(process.env.MEKIR_LOCAL_STATE || path.join(os.homedir(),'.mekir'),'smart-search');
function presetFor(id) { const p=presets.find(item=>item.id===id); assert(p,'Unknown model provider.'); return p; }
function baseUrl(value) {
  const url=new URL(value);
  assert((url.protocol==='https:' || url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) &&
    !url.username && !url.password && !url.search && !url.hash, 'Use an HTTPS API root or a local HTTP gateway.');
  return url.href.replace(/\/+$/,'');
}

function config(input, sourceIds) {
  const p=presetFor(input.provider);
  assert(protocols.includes(input.protocol) && (input.protocol==='codex')===(p.id==='codex'),'Invalid API protocol.');
  const model=String(input.model || '').trim();
  assert(model.length<=180 && !/[\r\n\0]/.test(model) && (model || p.id==='codex'),'Specify a model ID.');
  const cliPath=String(input.cliPath || '').trim();
  assert(!cliPath || path.isAbsolute(cliPath) && /^codex(?:\.exe|\.cmd)?$/i.test(path.basename(cliPath)),'Choose the Codex executable.');
  assert(typeof input.allowRecords==='boolean' && Array.isArray(input.sourceIds) && input.sourceIds.every(id=>sourceIds.includes(id)), 'Select registered project sources.');
  const rounds=input.rounds ?? 2, tokenBudget=input.tokenBudget ?? 36000;
  assert(Number.isInteger(rounds) && rounds>=1 && rounds<=4 && Number.isInteger(tokenBudget) && tokenBudget>=4000 && tokenBudget<=120000,'Invalid query budget.');
  return {provider:p.id,protocol:input.protocol,base:p.id==='codex'?'':baseUrl(input.base || p.base),model,cliPath:p.id==='codex'?cliPath:'',allowRecords:input.allowRecords,sourceIds:[...new Set(input.sourceIds)],rounds,tokenBudget};
}
function fileFor(store,project) {return path.join(configDir(),'projects',digest(Buffer.from(pathKey(store.root)+'\n'+project.id))+'.json');}
async function settings(store) {
  const {project}=await store.manifest(), sources=project.evidenceSources || [];
  let value;
  try {value=JSON.parse(await fs.readFile(fileFor(store,project),'utf8'));} catch(e){if(e.code!=='ENOENT')throw e;}
  if(value) value=config({...value,sourceIds:value.sourceIds.filter(id=>sources.some(s=>s.id===id))},sources.map(s=>s.id));
  return { value:value || null, presets, sources };
}
async function save(store,input) {
  const {project}=await store.manifest(), value=config(input,(project.evidenceSources || []).map(s=>s.id));
  const file=fileFor(store,project);
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await atomicWrite(file,Buffer.from(JSON.stringify(value)));
  return value;
}
function keyFile(value) {return path.join(configDir(),'keys',digest(Buffer.from([value.provider,value.protocol,value.base].join('\n'))));}
async function desktopKey(value,change) {
  if(value.protocol==='codex')return '';
  const { safeStorage }=require('electron'),file=keyFile(value);
  if(typeof change==='string' && change) {
    assert(change.length<=8192 && await safeStorage.isAsyncEncryptionAvailable(),'System credential storage is unavailable.');
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    await atomicWrite(file,await safeStorage.encryptStringAsync(change));return change;
  }
  if(change===null){await fs.rm(file,{force:true});return '';}
  try {const encrypted=await fs.readFile(file);return (await safeStorage.decryptStringAsync(encrypted)).result;}
  catch(e){if(e.code!=='ENOENT')throw e;return '';}
}
function envKey(value) {
  const p=presetFor(value.provider);
  // A credential for an official API must never be reused automatically for a different gateway.
  if (p.id==='codex') return '';
  if (p.id==='compatible' || value.base!==p.base) return process.env.MEKIR_AI_API_KEY || '';
  return process.env[p.env] || '';
}
module.exports={presets,config,presetFor,settings,save,desktopKey,envKey};

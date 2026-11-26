import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const { FileStore } = require('../electron/file-store.cjs');
const { createExampleProject } = require('../electron/research-example.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mekir-smart-ui-')));
const project = path.join(tmp,'project'), profile = path.join(tmp,'profile');
process.env.MEKIR_LOCAL_STATE = path.join(tmp,'state');

let submitted = 0, fail = false;
const server = http.createServer(async (req,res) => {
  try {
    if (req.url === '/v1/models') { res.end(JSON.stringify({data:[{id:'evidence-test'}]})); return; }
    assert.equal(req.url,'/v1/chat/completions');
    if (fail==='hold') return;
    if (fail) { res.writeHead(503); res.end(); return; }
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    const input = JSON.parse(Buffer.concat(pieces)), question = JSON.parse(input.messages[1].content);
    const record = question.evidence.find(entry=>entry.trials?.some(t=>t.trial==='timing-repeat'));
    assert.ok(record);
    const row = record.trials.find(t=>t.trial==='timing-repeat');
    const args = {claims:[{text:'步道次日的复测有原始计时。',proofs:[{ref:row.ref,quote:'timing-repeat'}]}],tables:[record.ref],gaps:[]};
    submitted++;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'verified',type:'function',function:{name:'finish',arguments:JSON.stringify(args)}}]}}]}));
  } catch (error) { res.writeHead(500); res.end(); console.error(error); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let app;
try {
  const store = await createExampleProject(project);
  await fs.writeFile(path.join(project,'示例证据','steps.csv'),'view,ms\ntrail,10\ncanopy,33\ntrail,20\n');
  await store.indexEvidence('trail-raw',{sourceId:'forest-samples',relativePath:'steps.csv',title:'步道逐轮计时 CSV'});
  const record = await store.read('forest-validation');
  await store.writeBatch({records:[{id:record.record.id,ifRevision:record.revision,evidence:[...record.record.evidence,'trail-raw'],
    body:'# 步道次日复测\n\n补基线后在林间步道复测。\n\n## 实验试次\n\n| Trial ID | Date | 条件 | 中位数 | 对照 | 原始证据 |\n| --- | --- | --- | --- | --- | --- |\n| timing-repeat | 2026-11-14 | 步道次日复测 | 15.00 | 待补 | [原始计时](mekir:trail-raw) |\n'}]});
  const manifest = await store.manifest();
  await store.configure({ifRevision:manifest.revision,project:{...manifest.project,search:{...manifest.project.search,
    measurements:[{recordId:'forest-validation',field:'中位数',column:'ms',where:{view:'trail'},statistic:'median'}]}}});
  const settings = new FileStore(profile);
  await settings.init(); await settings.changeRecentFolders('remember',project);
  const env = {...process.env,MEKI_TEST:'1',MEKI_USER_DATA:profile,NO_PROXY:'127.0.0.1,localhost'};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath:env.MEKI_EXECUTABLE||require('electron'),args:env.MEKI_EXECUTABLE ? [] : [root],env});
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('#shell[data-ready="true"]');
  await page.locator('#sidebar-settings-button').click();
  await page.locator('[data-sidebar-setting=research-ai-settings]').click();
  const config = page.locator('#research-ai-settings');
  await config.locator('[name=provider]').selectOption('compatible');
  await config.locator('[name=base]').fill('http://127.0.0.1:'+server.address().port+'/v1');
  await config.locator('[data-model-list]').click();
  await config.locator('datalist option[value=evidence-test]').waitFor({state:'attached'});
  await config.locator('[name=model]').fill('evidence-test');
  await config.locator('[name=records]').check(); await config.locator('[name=source][value=forest-samples]').check();
  await config.locator('[type=submit]').click(); await config.waitFor({ state:'hidden' });
  await page.locator('[data-research-search]').click();
  const search = page.locator('#research-search-dialog');
  await search.locator('label:has(input[value=smart])').click();
  await search.locator('[name=query]').fill('步道次日复测 timing-repeat');
  await search.locator('[type=submit]').click();
  await search.locator('[data-answer-status=complete]').waitFor({timeout:150000});
  const numeric = search.locator('.research-ai-number');
  assert.equal(await numeric.innerText(),'15.00');
  assert.equal(await search.getByRole('button',{name:'待补'}).count(),0);
  await numeric.click();
  const preview = page.locator('dialog.research-evidence-preview');
  const selection = preview.locator('[data-research-search-target]');
  await selection.first().waitFor();
  assert.deepEqual(await selection.evaluateAll(cells=>cells.map(c=>[c.dataset.sourceRow,c.textContent])),[['1','10'],['3','20']]);
  await preview.locator('[data-tools-close]').first().click(); await numeric.waitFor();
  assert.equal(await numeric.evaluate(b=>b===document.activeElement),true);
  await search.locator('.research-ai-trial').click();
  await page.locator('#visual-editor [data-research-search-target]').filter({hasText:'timing-repeat'}).waitFor();
  await page.locator('[data-action=research-close-reader]').click();
  await numeric.waitFor();
  assert.equal(submitted,1);
  assert.equal(await search.locator('[name=query]').inputValue(),'步道次日复测 timing-repeat');
  fail = true;
  await search.locator('[type=submit]').click();
  await search.locator('.research-search-results:not([aria-busy]) [data-answer-status=partial]').waitFor({timeout:150000});
  assert.equal(await search.locator('.research-ai-number').innerText(),'15.00');
  assert.equal(await search.locator('.research-ai-conclusion').count(),0);
  fail='hold';
  await search.locator('[type=submit]').click();
  await search.locator('.research-search-results[aria-busy] .research-ai-number').waitFor({timeout:150000});
  await search.locator('[data-search-cancel]').click();
  await search.locator('.research-search-results:not([aria-busy]) .research-ai-number').waitFor();
  await fs.appendFile(path.join(project,'示例证据','steps.csv'),'trail,30\n');
  await search.locator('.research-ai-number').click();
  await preview.waitFor(); assert.equal(await preview.locator('[data-research-search-target]').count(),0);
  await preview.locator('[data-tools-close]').first().click(); await numeric.waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS configure a provider, discover models, verify citations, open original rows, return to the answer and recover local evidence on failure');
} finally {
  await app?.close(); server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve)); await fs.rm(tmp,{recursive:true,force:true});
}

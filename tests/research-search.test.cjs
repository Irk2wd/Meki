'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createExampleProject } = require('../electron/research-example.cjs');
const { searchProject } = require('../electron/research-search.cjs');
const { markdownPassages, reportPassages } = require('../electron/research-search-passages.cjs');

test('rank tables, locate original pages and trials, and refresh modified or removed sources', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'mekir-search-'));
  const old = { local: process.env.MEKIR_LOCAL_STATE, search: process.env.MEKIR_SEARCH_HOME };
  process.env.MEKIR_LOCAL_STATE = path.join(temp,'bindings');
  process.env.MEKIR_SEARCH_HOME = path.join(temp,'search');
  t.after(async () => {
    for (const [key,value] of [['MEKIR_LOCAL_STATE',old.local],['MEKIR_SEARCH_HOME',old.search]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const store = await createExampleProject(path.join(temp,'project'));
  const search = (query, options = {}) => searchProject(store, { query, ...options });
  for (const [format,id,page] of [['pptx','forest-slides',3],['pdf','forest-observations',2]]) {
    const { results,problems } = await search('不同机位的计时对比', {format});
    assert.deepEqual(problems,[]);
    assert.equal(results[0].id,id);
    assert.equal(results[0].hits[0].locator.page,page);
    assert.equal(results[0].hits[0].dataTable,true);
  }
  const hit = (await search('baseline-repeat', {from:'2026-11-08',to:'2026-11-08',phase:'exploration'})).results.find(d => d.id==='tile-culling');
  assert.ok(hit.hits.some(h=>h.locator.trialId==='baseline-repeat' && h.locator.date==='2026-11-08'));
  assert.ok(!hit.hits.some(h=>h.locator.trialId==='tile-on'));
  const record=await store.read('tile-culling');
  await store.writeBatch({records:[{id:record.record.id,ifRevision:record.revision,body:record.body+'\n\n## 校验\n\nLuminometer readings agree.\n'}]});
  const spelling = (await search('luminomoter')).results[0];
  assert.equal(spelling.id,'tile-culling'); assert.equal(spelling.hits[0].locator.heading,'校验');
  const current=await store.manifest();
  await store.configure({ifRevision:current.revision,project:{...current.project,search:{aliases:{'亮度读头':['Luminometer']},sourceIds:[]}}});
  assert.equal((await search('亮度读头')).results[0].id,'tile-culling');
  assert.deepEqual((await search('机位',{format:'pptx'})).results,[]);
  const smart=spawnSync(process.execPath,[require.resolve('../electron/research-cli.cjs'),'smart-search',store.root,'--query','机位','--format','pptx'],{encoding:'utf8'});
  assert.equal(smart.status,0,smart.stderr);
  assert.equal(JSON.parse(smart.stdout).results[0].id,'forest-slides');
  assert.deepEqual((await search('机位',{format:'pptx'})).results,[]);
  const cli=spawnSync(process.execPath,[require.resolve('../electron/research-cli.cjs'),'search',store.root,'--query','亮度读头','--limit','1'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).results[0].hits[0].locator.heading,'校验');
});

test('paragraph anchors retain repeated paragraphs and table units; report extraction keeps original page numbers', async () => {
  const body='## 测量\n\n段落一。\n\n段落一。\n\n| 方法 | 帧时间 (ms) |\n| --- | --- |\n| A | 2 |\n| B | 3 |';
  const p=markdownPassages(body);
  assert.deepEqual(p.slice(0,2).map(p=>[p.locator.line,p.locator.occurrence]),[[3,0],[5,1]]);
  assert.equal(p[3].strength,2); assert.match(p[3].text,/帧时间 \(ms\) 3/);
  const bytes=await fs.readFile(path.join(__dirname,'../electron/research-example/forest-briefing.pptx'));
  assert.deepEqual((await reportPassages('pptx',bytes)).map(p=>[p.locator.page,p.strength]),[[1,0],[2,0],[3,2]]);
});

test('the distributed PDF extractor runs outside node_modules', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mekir-distribution-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { stageRuntime } = require('../electron/research-search-runtime.cjs');
  await stageRuntime(temp);
  const { pathToFileURL } = require('node:url');
  const api = await import(pathToFileURL(path.join(temp, 'search-runtime', 'pdf', 'index.mjs')).href);
  const bytes = await fs.readFile(path.join(__dirname, '../electron/research-example/forest-observations.pdf'));
  const document = await api.getDocumentProxy(new Uint8Array(bytes));
  try { assert.equal(document.numPages, 2); }
  finally { await document.loadingTask.destroy(); }
});

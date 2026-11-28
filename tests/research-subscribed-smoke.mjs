import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mekir-subscribed-ui-'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const pixel = await require('sharp')({create:{width:12,height:8,channels:3,background:'#69865c'}}).png().toBuffer();
const hash = digest(pixel);
const secondPixel = await require('sharp')({create:{width:12,height:8,channels:3,background:'#313d2d'}}).png().toBuffer();
const secondHash = digest(secondPixel);
const projectId = 'render-benchmark';
const shared = {format:'mekir-preview/1', asOf:'2026-11-17', project:{id:projectId,title:'森林远程研究',description:'检验林间步道。',phaseGoals:'checklist'},
  phases:[{id:'validation',title:'复测与验证',description:'比较两种树冠。',start:'2026-11-01',end:null,records:3,latest:'2026-11-17',
    goals:[{text:'补齐基线',done:true}],finding:{date:'2026-11-17',text:'未分享正文的最新结论'},days:[
      {date:'2026-11-15',records:2,trials:0},{date:'2026-11-17',records:1,trials:1}]}],
  items:[{id:'baseline',kind:'entry',label:'实验',phases:['validation'],date:'2026-11-15',title:'补基线',text:'计时对比',body:'# 补基线\n\n林间步道计时对比。\n\n[次日复测](mekir:retest)\n\n[私有资料](file:///private/secret.md)'},
    {id:'retest',kind:'summary',label:'总结',phases:['validation'],coverage:{start:'2026-11-15',end:'2026-11-16'},date:'2026-11-16',title:'次日复测',text:'两次计时一致。'},
    {id:'canopy',kind:'comparison',label:'可视化',phases:['validation'],date:'2026-11-16',title:'树冠对比',text:'同机位。',figure:{columns:['简化','原始'],rows:[{label:'步道',images:[hash,secondHash]}]}}]};
const files = new Map();
function publish() {
  const bytes = Buffer.from(JSON.stringify(shared));
  const revision = digest(bytes);
  files.set('/latest.json',Buffer.from(JSON.stringify({format:shared.format,projectId,revision,publishedAt:new Date().toISOString()})));
  files.set('/snapshots/' + revision + '.json',bytes);
  files.set('/media/' + hash + '.png',pixel);
  files.set('/media/' + secondHash + '.png',secondPixel);
}
publish();
const methods = [];
const server = http.createServer((req,res) => {
  methods.push(req.method);
  const file = files.get(req.url);
  res.writeHead(file && req.method === 'GET' ? 200 : 404); res.end(file);
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const env = {...process.env, MEKI_TEST:'1', MEKI_USER_DATA:path.join(temp,'profile'), MEKIR_LOCAL_STATE:path.join(temp,'local-state'), MEKI_TEST_RESEARCH_PARENT:temp, MEKI_TEST_DISCARD:'discard'};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({executablePath:process.env.MEKI_EXECUTABLE || require('electron'),args:process.env.MEKI_EXECUTABLE ? [] : [root],env});
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('#shell[data-ready=true]').waitFor();
}
const click = selector => page.locator(selector).first().click();
const openPicker = () => click('.research-project-switch');
const idle = () => page.waitForFunction(() => !document.body.classList.contains('is-busy'));
try {
  await launch();
  await click('[data-action=research-demo]:visible');
  await page.locator('[data-research-phase=validation]').waitFor();
  const localRoot = (await page.evaluate(() => window.meki.researchSnapshot())).root;
  const localBefore = await page.evaluate(() => window.meki.researchSnapshot());
  await openPicker(); await click('[data-remote-subscribe]');
  await page.locator('#research-remote-settings [name=url]').fill('http://127.0.0.1:' + server.address().port + '/');
  await click('#research-remote-settings [type=submit]');
  await page.getByRole('heading',{name:'森林远程研究',exact:true}).waitFor();
  assert.equal(await page.locator('#research-remote-viewer[open], [data-research-new], [data-research-edit]').count(),0);
  assert.match(await page.locator('.research-overview-stats').textContent(),/3 条实验/);
  const virtual = await page.evaluate(async () => 'subscription:' + (await window.meki.previewSubscriptions())[0].id);
  assert.match(await page.evaluate(async root => { try { await window.meki.writeResearchBatch(root,{records:[]}); return 'wrote'; } catch(e) { return e.message; } },virtual),/只读/);
  await click('[data-research-axis-action=in]');
  await click('[data-research-reset-range]');
  await click('[data-shared-day=validation][data-date="2026-11-17"]');
  assert.equal(await page.locator('#research-date').inputValue(),'2026-11-17');
  assert.equal(await page.locator('[data-research-goal]').first().isDisabled(),true);
  await click('[data-research-clear]');
  await click('[data-research-phase=validation]');
  await page.locator('.research-content').evaluate(el => {
    el.addEventListener('pointerdown', () => { el.dataset.openScroll = String(el.scrollTop); }, {once:true});
  });
  await click('.research-journal [data-research-record=baseline]');
  const reader = page.locator('#research-shared-document');
  await reader.getByRole('heading',{name:'补基线'}).waitFor();
  assert.equal(await reader.locator('.ProseMirror').getAttribute('contenteditable'),'false');
  assert.equal(await page.locator('[data-action=research-edit-body]:visible').count(),0);
  await reader.locator('.ProseMirror').press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await reader.locator('.ProseMirror').press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.locator('#find-query').fill('林间步道');
  await page.locator('#find-count').filter({hasText:'1 / 1'}).waitFor();
  await click('#find-panel [data-action=find-close]');
  assert.equal(await reader.locator('a[href^="file:"]').count(),0);
  await reader.getByRole('link',{name:'次日复测',exact:true}).click();
  await reader.getByRole('heading',{name:'次日复测'}).waitFor();
  await idle(); await click('[data-action=research-reader-back]');
  await reader.getByRole('heading',{name:'补基线'}).waitFor();
  await click('[data-action=research-close-reader]');
  await reader.waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-research-phase=validation]').getAttribute('aria-pressed'),'true');
  assert.ok(await page.locator('.research-content').evaluate(el => Math.abs(el.scrollTop - Number(el.dataset.openScroll)) < 2));
  await click('.research-journal [data-research-record=canopy], .research-journal [data-research-progress-link=canopy]');
  const comparison = page.locator('#research-comparison-dialog');
  await comparison.waitFor();
  assert.equal(await comparison.locator('[data-comparison-edit]').count(),0);
  await comparison.locator('[data-comparison-layout=wipe]').click();
  await comparison.locator('img').filter({visible:true}).first().waitFor();
  await comparison.locator('[data-comparison-close]').click();
  await click('[data-research-search]');
  await page.locator('#research-search-dialog [name=query]').fill('计时对比');
  await click('#research-search-dialog [type=submit]');
  await page.locator('#research-search-dialog [data-result-index]').first().click();
  await reader.getByRole('heading',{name:'补基线'}).waitFor();
  await reader.locator('[data-research-search-target]').waitFor();
  await click('[data-action=research-close-reader]'); await reader.waitFor({state:'hidden'});
  if (await page.locator('#research-search-dialog[open]').count()) await click('[data-search-close]');
  shared.project.title='森林远程研究 · 已更新'; publish();
  await click('#research-workspace [data-action=refresh]');
  await page.getByRole('heading',{name:shared.project.title,exact:true}).waitFor();
  assert.equal(await page.locator('[data-research-phase=validation]').getAttribute('aria-pressed'),'true');
  await app.close(); app=undefined;
  await new Promise(resolve => server.close(resolve));
  await launch();
  await page.getByRole('heading',{name:shared.project.title,exact:true}).waitFor();
  await page.locator('[data-subscription-status]').filter({hasText:'离线'}).waitFor();
  await click('[data-research-destination=entries]');
  await click('[data-research-record=baseline]');
  await page.locator('#research-shared-document').getByRole('heading',{name:'补基线'}).waitFor();
  await click('[data-action=research-close-reader]');
  await page.locator('#research-shared-document').waitFor({state:'hidden'});
  await idle(); await openPicker(); await click('[data-research-project]');
  await page.locator('[data-research-new=entry]').first().waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('mekir.lastSubscription')),null);
  const after = await page.evaluate(() => window.meki.researchSnapshot());
  assert.equal(after.root,localRoot); assert.equal(after.revision,localBefore.revision);
  assert.deepEqual(after.records.map(r => r.revision),localBefore.records.map(r => r.revision));
  assert.deepEqual([...new Set(methods)],['GET']);
  assert.deepEqual(errors,[]);
  console.log('Subscribed and local projects passed timeline, read-only reader, links, comparisons, search, refresh and offline restart checks.');
} catch (error) {
  console.error('Requests:', methods, 'renderer:', errors, 'visible:', await page?.locator('#research-workspace h1, #research-workspace [role=alert], [data-subscription-status], dialog[open]').allTextContents().catch(() => []));
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(temp,{recursive:true,force:true});
}

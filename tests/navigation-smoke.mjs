import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
const run = await fs.realpath(await fs.mkdtemp(path.join(root,'test-results','navigation-')));
const a = path.join(run,'Workspace A'), b = path.join(run,'Workspace B'), outside = path.join(run,'outside'), missing = path.join(run,'missing'), alias = path.join(run,'replaced');
const alpha = path.join(a,'alpha'), sub = path.join(alpha,'sub'), child = path.join(sub,'child.md'), note = path.join(alpha,'note.md'), z = path.join(a,'z.md'), bFile = path.join(b,'beta.md'), secret = path.join(outside,'secret.md');
await fs.mkdir(sub,{recursive:true}); await fs.mkdir(path.join(a,'empty')); await fs.mkdir(b); await fs.mkdir(outside);
await fs.writeFile(child,'# Child\n'); await fs.writeFile(note,'# Note\n'); await fs.writeFile(z,'\uFEFF# Z\r\n\r\nKeep original bytes.\r\n'); await fs.writeFile(bFile,'# Beta\n'); await fs.writeFile(secret,'private synthetic content');
await fs.symlink(outside,alias,process.platform==='win32'?'junction':'dir');
const profile=path.join(run,'profile'); await fs.mkdir(profile);
await fs.writeFile(path.join(profile,'state.json'),JSON.stringify({workspaceRoot:a,recentFolders:[b,missing,alias].map((folder,index)=>({path:folder,pinned:false,lastOpened:index+1}))}));
const env={...process.env,MOYE_TEST:'1',MOYE_USER_DATA:profile,MOYE_TEST_FOLDER_PATH:a,MOYE_TEST_DISCARD:'cancel',MOYE_TEST_CONFLICT:'cancel'};
delete env.ELECTRON_RUN_AS_NODE;
const modifier=process.platform==='darwin'?'Meta':'Control', end=process.platform==='darwin'?'Meta+ArrowDown':'Control+End';
const results=[],errors=[]; let app,page;
function pass(message){results.push(message);console.log(`PASS ${message}`);}
async function idle(){await page.waitForFunction(()=>!document.body.classList.contains('is-busy'));}
async function action(name){await page.locator(`[data-action="${name}"]`).first().evaluate(node=>node.click());await idle();}
async function focus(file){await page.locator('.workspace-tree-row').evaluateAll((nodes,file)=>{const row=nodes.find(node=>node.dataset.wsPath===file);if(!row)throw Error(`Missing row ${file}`);row.focus();},file);}
async function focused(file){await page.waitForFunction(file=>document.activeElement?.dataset.wsPath===file,file);}
async function exists(file){return page.locator('.workspace-tree-row').evaluateAll((nodes,file)=>nodes.some(node=>node.dataset.wsPath===file),file);}
async function refresh(){await page.locator('[data-ws="refresh"]').evaluate(node=>node.click());await idle();}
async function folders(){await action('recent-folders');await page.locator('#recent-folders-dialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#recent-folder-status').textContent.includes('正在读取'));}
async function folderAction(folder,action){await page.locator('.recent-folder-row').evaluateAll((nodes,{folder,action})=>{const row=nodes.find(node=>node.dataset.folderPath===folder);if(!row)throw Error(`Missing folder ${folder}`);row.querySelector(`[data-folders="${action}"]`).click();},{folder,action});await page.waitForFunction(()=>!document.querySelector('#recent-folders-dialog').hasAttribute('aria-busy'));await idle();}
async function denied(file){return page.evaluate(async file=>{try{await window.moye.openDocument(file);return false;}catch{return true;}},file);}
async function launch(){
  app=await electron.launch({executablePath:process.env.MOYE_EXECUTABLE||require('electron'),args:process.env.MOYE_EXECUTABLE?['--open',z]:[root,'--open',z],env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());await page.waitForSelector('#shell[data-ready="true"]');await page.locator('[data-tab="files"]').click();
}
async function stop(){if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});app=null;}}
try{
  await launch();
  assert.equal(await page.locator('.workspace-tree-row[tabindex="0"]').count(),1);
  assert.equal(await page.locator('.workspace-tree-row button:not([tabindex="-1"])').count(),0);
  await focus(z);await page.keyboard.press('Home');await focused(alpha);
  await page.keyboard.press('ArrowRight');await focused(sub);await page.keyboard.press('ArrowRight');await focused(child);
  assert.equal(await page.locator('.workspace-tree-row:focus').getAttribute('aria-level'),'3');
  assert.equal(await page.locator('.workspace-tree-row:focus').getAttribute('aria-posinset'),'1');
  assert.equal(await page.locator('.workspace-tree-row:focus').getAttribute('aria-setsize'),'1');
  assert.equal(await page.locator('#document-name').innerText(),'z.md');
  await page.keyboard.press('ArrowLeft');await focused(sub);await page.keyboard.press('ArrowLeft');assert.equal(await exists(child),false);
  assert.equal(await page.locator('.workspace-tree-row:focus').getAttribute('aria-expanded'),'false');
  await page.keyboard.press('ArrowRight');await focused(sub);assert.equal(await exists(child),true);
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowDown');await focused(note);await page.keyboard.press('ArrowUp');await focused(child);
  await page.keyboard.press('End');await focused(z);await page.keyboard.press('ArrowDown');await focused(z);
  pass('roving file tree exposes hierarchy and arrow/Home/End navigation without opening on focus');

  await page.locator('[data-mode="source"]').click();await page.locator('#source-editor .cm-content').click();await page.keyboard.press(end);await page.keyboard.insertText('\nUnsaved navigation buffer');
  await focus(child);await page.keyboard.press('Enter');await idle();await page.waitForFunction(()=>document.querySelector('#document-name').textContent==='child.md');
  assert.equal(await page.locator('.document-tab').count(),2);assert.equal(await page.locator('.tab-dirty.visible').count(),1);
  await focus(child);await page.keyboard.press('F2');await page.locator('#workspace-entry-name').fill('renamed.md');await page.locator('#workspace-form button[type="submit"]').click();await idle();
  const renamed=path.join(sub,'renamed.md');await focused(renamed);assert.equal(await fs.readFile(renamed,'utf8'),'# Child\n');assert.equal(await fs.stat(child).catch(()=>null),null);
  assert.equal(await page.locator('#document-name').innerText(),'renamed.md');
  pass('Enter opens a separate document, and F2 renames while retaining dirty tabs and tree focus');

  await fs.writeFile(path.join(a,'first.md'),'# External addition');await refresh();await focused(renamed);
  await page.keyboard.press('Shift+F10');await page.locator('#workspace-menu').waitFor({state:'visible'});assert.equal(await page.locator('#workspace-menu button:focus').count(),1);
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await focused(renamed);
  await page.locator('[data-ws="root-menu"]').click();assert.equal(await page.locator('.workspace-tree-row[tabindex="0"]').count(),1);await page.keyboard.press('Escape');await focused(renamed);
  await fs.unlink(renamed);await refresh();await focused(sub);
  await focus(note);await page.locator('[data-ws="toggle"]').evaluateAll((nodes,alpha)=>nodes.find(node=>node.dataset.wsPath===alpha).click(),alpha);await focused(alpha);assert.equal(await exists(note),false);
  await page.keyboard.press('ArrowRight');await focused(alpha);assert.equal(await exists(note),true);
  pass('refresh preserves focused paths, deletion/collapse returns to a visible ancestor, and keyboard menus restore focus');

  await page.locator('#file-filter').fill('note.md');assert.equal(await page.locator('.workspace-tree-row').count(),1);assert.equal(await page.locator('.workspace-tree-row[tabindex="0"]').count(),1);
  assert.equal(await page.locator('#file-filter').evaluate(node=>node===document.activeElement),true);
  await page.locator('#file-filter').fill('alpha/sub');await focus(sub);await page.keyboard.press('Enter');assert.equal(await page.locator('#file-filter').inputValue(),'');await focused(sub);
  await page.locator('#file-filter').fill('alpha/sub');await focus(sub);await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#file-filter').inputValue(),'');await focused(sub);
  await page.locator('#workspace-sort').selectOption('name-desc');assert.equal(await page.locator('.workspace-tree-row[tabindex="0"]').getAttribute('data-ws-path'),sub);
  pass('filtering and sorting keep one tree tab stop, preserve input focus, and expand filtered directories');

  assert.equal(await denied(bFile),true);assert.equal(await denied(secret),true);
  await folders();assert.equal(await page.locator('.recent-folder-row').count(),4);assert.equal(await denied(bFile),true);
  await folderAction(b,'pin');assert.equal(await page.locator('.recent-folder-row').first().getAttribute('data-folder-path'),b);
  assert.equal(await page.locator('.recent-folder-row').first().locator('.recent-folder-pin').getAttribute('aria-pressed'),'true');
  await page.screenshot({path:path.join(run,'recent-folders.png'),animations:'disabled'});
  await page.locator('[data-folders="close"]').click();await page.waitForTimeout(700);
  await stop();await launch();await folders();
  assert.equal(await page.locator('.recent-folder-row').first().getAttribute('data-folder-path'),b);assert.equal(await denied(bFile),true);
  pass('recent folder pinning survives restart; listing and pinning do not authorize unopened contents');

  await folderAction(missing,'open');assert.equal(await page.locator('#recent-folders-dialog').isVisible(),true);assert.match(await page.locator('#recent-folder-status').innerText(),/无法打开最近文件夹/);
  assert.equal(await page.locator('#workspace-name').innerText(),'Workspace A');
  await folderAction(alias,'open');assert.match(await page.locator('#recent-folder-status').innerText(),/替换|链接/);assert.equal(await denied(secret),true);
  const invalid=await page.evaluate(async outside=>{const failures=[];for(const input of [{action:'remember',path:outside},{action:'pin',path:outside},{action:'clear',path:outside}]){try{await window.moye.changeRecentFolders(input);failures.push(false);}catch{failures.push(true);}}try{await window.moye.openRecentFolder(outside);failures.push(false);}catch{failures.push(true);}return failures;},outside);
  assert.deepEqual(invalid,[true,true,true,true]);
  pass('missing and replaced recent locations report visible errors without changing the workspace or granting access');

  const beforeTabs=await page.locator('.document-tab').count();await folderAction(b,'open');await page.locator('#recent-folders-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#workspace-name').innerText(),'Workspace B');assert.equal(await page.locator('.document-tab').count(),beforeTabs);
  await focus(bFile);await page.keyboard.press('Enter');await idle();await page.waitForFunction(()=>document.querySelector('#document-name').textContent==='beta.md');
  await folders();const filesBefore=(await page.evaluate(()=>window.moye.boot())).recentFiles;
  await page.locator('[data-folders="clear"]').click();await page.waitForFunction(()=>document.querySelectorAll('.recent-folder-row').length===1);
  assert.equal(await page.locator('.recent-folder-row').first().getAttribute('data-folder-path'),b);
  await folderAction(b,'remove');assert.equal(await page.locator('.recent-folder-row').count(),0);
  assert.deepEqual((await page.evaluate(()=>window.moye.boot())).recentFiles,filesBefore);assert.equal(await fs.readFile(bFile,'utf8'),'# Beta\n');
  await page.locator('[data-folders="close"]').click();assert.equal(await page.locator('#workspace-name').innerText(),'Workspace B');
  await page.locator('.document-tab [role="tab"]').evaluateAll((nodes,z)=>nodes.find(node=>node.title===z).click(),z);await idle();
  await page.locator('[data-mode="source"]').click();assert.match(await page.locator('#source-editor').innerText(),/Unsaved navigation buffer/);
  assert.equal(await fs.readFile(z,'utf8'),'\uFEFF# Z\r\n\r\nKeep original bytes.\r\n');
  pass('explicit recent selection opens its workspace; clear/remove preserve pinned choices, recent files, disk data and unsaved tabs');

  await page.screenshot({path:path.join(run,'navigation.png'),animations:'disabled'});assert.deepEqual(errors,[]);pass('no renderer exceptions');
}finally{
  if(page){await page.screenshot({path:path.join(run,'last-state.png'),animations:'disabled',timeout:5000}).catch(()=>{});await fs.writeFile(path.join(run,'last-dom.html'),await page.content().catch(()=>''));}
  await stop();await fs.writeFile(path.join(run,'results.json'),JSON.stringify({results,errors},null,2));console.log(`Evidence: ${run}`);
}

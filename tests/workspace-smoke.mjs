import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
// Test evidence may live behind a workspace junction; compare canonical OS paths.
const run = await fs.realpath(await fs.mkdtemp(path.join(root,'test-results','workspace-')));
const folder = path.join(run,'documents');
await fs.mkdir(path.join(folder,'notes'),{recursive:true});
await fs.mkdir(path.join(folder,'archive'));
const originalPath = path.join(folder,'欢迎.md');
const linkedPath = path.join(folder,'notes','子稿.md');
const original = '\uFEFF# 欢迎\r\n\r\n[子稿](notes/%E5%AD%90%E7%A8%BF.md#目标)\r\n\r\nUnicode αβ\r\n';
await fs.writeFile(originalPath,original);
await fs.writeFile(linkedPath,'# 子稿\n\n第一段\n\n## 目标\n\nNeedle 中文内容\n\nneedle second\n');
const env={...process.env,MOYE_TEST:'1',MOYE_USER_DATA:path.join(run,'profile'),MOYE_TEST_FOLDER_PATH:folder,MOYE_TEST_OPEN_PATH:originalPath,MOYE_TEST_SAVE_PATH:path.join(folder,'恢复.md'),MOYE_TEST_DISCARD:'cancel',MOYE_TEST_CONFLICT:'cancel'};
delete env.ELECTRON_RUN_AS_NODE;
const modifier=process.platform==='darwin'?'Meta':'Control';
const end=process.platform==='darwin'?'Meta+ArrowDown':'Control+End';
const results=[],errors=[];
let app,page;
function pass(message){results.push(message);console.log(`PASS ${message}`);}
async function idle(){await page.waitForFunction(()=>!document.body.classList.contains('is-busy'));}
async function action(name){if(name==='folder')await page.keyboard.press(`${modifier}+Shift+O`);else if(name==='close-tab')await page.locator('.document-tab.active .close-document-tab').click();else await page.locator(`[data-action="${name}"]`).first().evaluate(button=>button.click());await idle();}
async function setting(name,value){await app.evaluate((_electron,{name,value})=>{process.env[name]=value;},{name,value});}
async function rowAction(file,action){await page.locator(`[data-ws="${action}"][data-ws-path]`).evaluateAll((nodes,file)=>{const node=nodes.find(node=>node.dataset.wsPath===file);if(!node)throw Error(`No row for ${file}`);node.click();},file);await idle();}
async function menu(file,action){await rowAction(file,'menu');await page.locator(`[data-ws-menu="${action}"]`).click();await idle();}
async function submit(name,destination){await page.locator('#workspace-entry-name').fill(name);if(destination)await page.locator('#workspace-destination').selectOption(destination);await page.locator('#workspace-form button[type="submit"]').click();await idle();}
async function hasRow(file){return page.locator('[data-ws="open"][data-ws-path]').evaluateAll((nodes,file)=>nodes.some(node=>node.dataset.wsPath===file),file);}
async function source(){await page.locator('[data-mode="source"]').click();return page.locator('#source-editor .cm-content');}
async function append(text){const editor=await source();await editor.click();await page.keyboard.press(end);await page.keyboard.insertText(text);}
async function quick(query){
  await page.keyboard.press(`${modifier}+k`);
  // A paste followed by Enter in the same turn must not open a stale result.
  await page.locator('#workspace-query').evaluate((input,value)=>{
    input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  },query);
  await idle();
}
try{
  app=await electron.launch({executablePath:process.env.MOYE_EXECUTABLE||require('electron'),args:process.env.MOYE_EXECUTABLE?[]:[root],env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.waitForSelector('#shell[data-ready="true"]');
  await action('folder');await action('open');
  assert.equal(await hasRow(linkedPath),true);
  await rowAction(path.join(folder,'notes'),'toggle');assert.equal(await hasRow(linkedPath),false);
  await rowAction(path.join(folder,'notes'),'toggle');assert.equal(await hasRow(linkedPath),true);
  await page.locator('#workspace-sort').selectOption('modified');
  await page.locator('#file-filter').fill('子稿');assert.equal(await hasRow(originalPath),false);assert.equal(await hasRow(linkedPath),true);
  await page.locator('#file-filter').fill('');
  pass('recursive tree, empty folders, collapse, sort and path filtering');

  await page.locator('[data-ws="root-menu"]').click();await page.locator('[data-ws-menu="create-folder"]').click();await submit('inbox');
  const inbox=path.join(folder,'inbox');assert.equal((await fs.stat(inbox)).isDirectory(),true);
  await menu(inbox,'create-file');await submit('new.md');
  let active=path.join(inbox,'new.md');assert.equal(await page.locator('#document-name').textContent(),'new.md');
  await append('# 草稿\n\n未保存的内容 α');
  await menu(active,'rename');await submit('renamed.md');active=path.join(inbox,'renamed.md');
  assert.equal(await page.locator('#dirty-dot').isVisible(),true);assert.match(await page.locator('#source-editor').innerText(),/未保存的内容/);
  assert.equal(await fs.readFile(active,'utf8'),'');assert.equal(await fs.stat(path.join(inbox,'new.md')).catch(()=>null),null);
  await action('save');assert.match(await fs.readFile(active,'utf8'),/未保存的内容/);
  await append('\n移动前的新增');
  await menu(active,'move');assert.match(await page.locator('#workspace-operation-hint').innerText(),/相对链接/);await submit('renamed.md',path.join(folder,'archive'));active=path.join(folder,'archive','renamed.md');
  assert.equal(await page.locator('#document-name').getAttribute('title'),active);assert.equal(await page.locator('#dirty-dot').isVisible(),true);
  await fs.writeFile(path.join(folder,'archive','asset.bin'),Buffer.from([1,2,3]));
  await menu(path.join(folder,'archive'),'rename');await submit('归档');active=path.join(folder,'归档','renamed.md');
  assert.equal(await page.locator('#document-name').getAttribute('title'),active);assert.equal(await page.locator('#dirty-dot').isVisible(),true);
  await action('save');assert.match(await fs.readFile(active,'utf8'),/移动前的新增/);assert.deepEqual(await fs.readFile(path.join(folder,'归档','asset.bin')),Buffer.from([1,2,3]));
  pass('create file/folder and rename/move parent paths preserve the active unsaved document and resources');

  await menu(originalPath,'copy');await submit('欢迎 副本.md',folder);
  const copy=path.join(folder,'欢迎 副本.md');assert.equal(await fs.readFile(copy,'utf8'),original);
  await menu(copy,'rename');await submit('欢迎.md');assert.equal(await fs.readFile(originalPath,'utf8'),original);assert.equal(await fs.readFile(copy,'utf8'),original);
  assert.match(await page.locator('#toast').innerText(),/已存在/);
  await menu(copy,'copy-path');
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='已复制完整路径');
  assert.equal(await app.evaluate(()=>process.env.MOYE_TEST_COPIED_PATH),copy);
  await menu(copy,'reveal');
  pass('duplicate preserves BOM/CRLF, occupied targets are rejected, and path actions use the native bridge');

  await append('\n快速打开前的未保存编辑');
  await quick('欢迎.md');assert.equal(await page.locator('#document-name').getAttribute('title'),originalPath);
  await quick('renamed.md');assert.equal(await page.locator('#dirty-dot').isVisible(),true);assert.match(await page.locator('#source-editor').innerText(),/快速打开前的未保存编辑/);
  await action('close-tab');assert.equal(await page.locator('#document-name').getAttribute('title'),active);
  await setting('MOYE_TEST_DISCARD','save');await action('close-tab');await quick('欢迎.md');
  assert.equal(await page.locator('#document-name').getAttribute('title'),originalPath);assert.match(await fs.readFile(active,'utf8'),/快速打开前的未保存编辑/);
  await page.locator('[data-mode="visual"]').click();
  await page.locator('.moye-document a').filter({hasText:'子稿'}).click({modifiers:[modifier]});await idle();
  await page.waitForFunction(()=>document.querySelector('#document-name').textContent==='子稿.md');
  assert.ok(await page.locator('.moye-document #目标').count());
  pass('quick open retains unsaved tabs, closing honors cancel/save, and relative links open their heading anchor');

  await page.keyboard.press(`${modifier}+Shift+k`);await page.locator('#workspace-query').fill('Needle');
  await page.waitForFunction(()=>document.querySelectorAll('#workspace-results [data-ws-result]').length===2);
  await page.locator('#workspace-case').check();await page.waitForFunction(()=>document.querySelectorAll('#workspace-results [data-ws-result]').length===1);
  await page.locator('#workspace-results [data-ws-result]').first().click();await idle();
  assert.equal(await page.locator('#source-editor').isVisible(),true);assert.match(await page.locator('#source-editor .cm-activeLine').innerText(),/Needle/);
  pass('workspace content search returns case-aware line matches and opens the source at the matching line');

  await append('\n本地未保存修改');await fs.writeFile(linkedPath,'# 外部版本\n\n磁盘内容必须保留\n');
  await page.locator('#external-banner').waitFor({state:'visible',timeout:15000});assert.match(await page.locator('#source-editor').innerText(),/本地未保存修改/);
  await setting('MOYE_TEST_DISCARD','cancel');await action('reload-document');assert.match(await page.locator('#source-editor').innerText(),/本地未保存修改/);
  await action('save');assert.match(await fs.readFile(linkedPath,'utf8'),/磁盘内容必须保留/);assert.equal(await page.locator('#dirty-dot').isVisible(),true);
  await setting('MOYE_TEST_DISCARD','discard');await action('reload-document');assert.equal(await page.locator('#dirty-dot').isVisible(),false);assert.match(await page.locator('#source-editor').innerText(),/外部版本/);
  const added=path.join(folder,'external.md');await fs.writeFile(added,'# externally created');
  await page.waitForFunction(file=>[...document.querySelectorAll('[data-ws="open"]')].some(node=>node.dataset.wsPath===file),added,{timeout:15000});
  await fs.unlink(added);await page.waitForFunction(file=>![...document.querySelectorAll('[data-ws="open"]')].some(node=>node.dataset.wsPath===file),added,{timeout:15000});
  pass('external changes refresh the tree and prompt reload without replacing dirty editor text or bypassing conflicts');

  await menu(linkedPath,'trash');assert.ok(await fs.stat(linkedPath));
  await setting('MOYE_TEST_TRASH','confirm');await menu(linkedPath,'trash');
  assert.equal(await fs.stat(linkedPath).catch(()=>null),null);assert.equal(await page.locator('#dirty-dot').isVisible(),true);assert.match(await page.locator('#source-editor').innerText(),/外部版本/);
  assert.equal(await page.locator('#document-name').getAttribute('title'),'尚未保存到文件');
  await action('save');assert.match(await fs.readFile(path.join(folder,'恢复.md'),'utf8'),/外部版本/);
  pass('trash requires explicit confirmation, uses the system recycle bin, and retains the active document for Save As');

  const outside=path.join(run,'outside.md');await fs.writeFile(outside,'outside must survive');
  const rejected=await page.evaluate(async file=>{try{await window.moye.workspaceOperation({action:'trash',path:file});return false;}catch{return true;}},outside);
  assert.equal(rejected,true);assert.equal(await fs.readFile(outside,'utf8'),'outside must survive');
  await page.screenshot({path:path.join(run,'workspace.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);pass('renderer bridge rejects operations outside the workspace; no renderer errors');
}finally{
  if(page){await page.screenshot({path:path.join(run,'last-state.png'),animations:'disabled',timeout:5000}).catch(()=>{});await fs.writeFile(path.join(run,'last-dom.html'),await page.content().catch(()=>''));}
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
  await fs.writeFile(path.join(run,'results.json'),JSON.stringify({results,errors},null,2));console.log(`Evidence: ${run}`);
}

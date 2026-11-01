'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WorkspaceStore, documentStatus, allowedName } = require('../electron/workspace-store.cjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-workspace-test-'));
  const root = path.join(temporary,'workspace'), outside = path.join(temporary,'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  t.after(() => fs.rm(temporary,{recursive:true,force:true}));
  const store = await WorkspaceStore.open(root);
  return {root:store.root,outside:await fs.realpath(outside),store};
}
const write = (root,name,value) => fs.writeFile(path.join(root,name),value);

test('workspace tree includes empty directories, natural order and file metadata but excludes caches/assets',async t=>{
  const {root,store}=await fixture(t);
  for(const name of ['empty','notes','.git','NODE_MODULES','note.assets']) await fs.mkdir(path.join(root,name));
  await write(root,'2.md','# two');await write(root,'10.md','# ten');await write(root,'image.png','binary');
  await write(root,'notes/中文.md','你好');await write(root,'.git/hidden.md','private');await write(root,'note.assets/hidden.md','asset');await write(root,'NODE_MODULES/hidden.md','dep');
  const tree=await store.snapshot();
  assert.deepEqual(tree.entries.map(entry=>entry.relativePath),['notes/中文.md','2.md','10.md']);
  assert.ok(tree.tree.some(entry=>entry.kind==='directory'&&entry.name==='empty'));
  assert.ok(tree.entries.every(entry=>entry.modifiedAt>0&&entry.size>0));
  const limited=await store.snapshot(1);assert.equal(limited.entries.length,1);assert.equal(limited.truncated,true);
});

test('create is exclusive and portable path names reject traversal, devices and protected directories',async t=>{
  const {root,outside,store}=await fixture(t);
  await store.operate({action:'create-folder',path:root,name:'草稿'});
  const file=await store.operate({action:'create-file',path:path.join(root,'草稿'),name:'新文稿.md'});
  assert.equal(await fs.readFile(file.path,'utf8'),'');
  await write(root,'草稿/新文稿.md','Do not overwrite');
  await assert.rejects(store.operate({action:'create-file',path:path.join(root,'草稿'),name:'新文稿.md'}),/已存在/);
  assert.equal(await fs.readFile(file.path,'utf8'),'Do not overwrite');
  for(const name of ['..','../bad.md','C:\\bad.md','file.md:stream','CON.md','trailing.','.GiT','a\0.md']) assert.throws(()=>allowedName(name));
  await assert.rejects(store.operate({action:'create-file',path:outside,name:'escape.md'}),/工作区/);
  await assert.rejects(store.operate({action:'create-file',path:root,name:'execute.js'}),/扩展名/);
});

test('copy, rename and move preserve exact UTF-8 BOM/CRLF bytes and never replace occupied names',async t=>{
  const {root,store}=await fixture(t);await fs.mkdir(path.join(root,'folder'));
  const bytes=Buffer.from('\uFEFF# 中文\r\n\r\n原始 α β\r\n');await write(root,'first.md',bytes);await write(root,'occupied.md','other');
  await store.operate({action:'copy',path:path.join(root,'first.md'),destination:root,name:'copy.md'});
  await store.operate({action:'rename',path:path.join(root,'copy.md'),name:'renamed.md'});
  await store.operate({action:'move',path:path.join(root,'renamed.md'),destination:path.join(root,'folder')});
  assert.deepEqual(await fs.readFile(path.join(root,'folder','renamed.md')),bytes);
  assert.deepEqual(await fs.readFile(path.join(root,'first.md')),bytes);
  await assert.rejects(store.operate({action:'rename',path:path.join(root,'first.md'),name:'occupied.md'}),/已存在/);
  assert.equal(await fs.readFile(path.join(root,'occupied.md'),'utf8'),'other');
  assert.deepEqual(await fs.readFile(path.join(root,'first.md')),bytes);
});

test('directory copies include resources and empty directories; moves reject descendant destinations',async t=>{
  const {root,store}=await fixture(t);await fs.mkdir(path.join(root,'notes','figures'),{recursive:true});await fs.mkdir(path.join(root,'notes','empty'));
  await write(root,'notes/a.md','![figure](figures/a.png)');await write(root,'notes/figures/a.png',Buffer.from([1,2,3,4]));
  await store.operate({action:'copy',path:path.join(root,'notes'),destination:root,name:'copy'});
  assert.deepEqual(await fs.readFile(path.join(root,'copy','figures','a.png')),Buffer.from([1,2,3,4]));
  assert.equal((await fs.stat(path.join(root,'copy','empty'))).isDirectory(),true);
  await assert.rejects(store.operate({action:'move',path:path.join(root,'notes'),destination:path.join(root,'notes','empty'),name:'nested'}),/子目录/);
  await store.operate({action:'rename',path:path.join(root,'notes'),name:'moved'});
  assert.equal(await fs.readFile(path.join(root,'moved','a.md'),'utf8'),'![figure](figures/a.png)');
});

test('a file created after target validation cannot be overwritten by rename or move',async t=>{
  const {root,store}=await fixture(t);await write(root,'source.md','source');
  const originalLink=fs.link;
  t.mock.method(fs,'link',async(source,target)=>{await fs.writeFile(target,'concurrent target',{flag:'wx'});return originalLink(source,target);});
  await assert.rejects(store.operate({action:'rename',path:path.join(root,'source.md'),name:'target.md'}),/无法安全移动/);
  assert.equal(await fs.readFile(path.join(root,'source.md'),'utf8'),'source');
  assert.equal(await fs.readFile(path.join(root,'target.md'),'utf8'),'concurrent target');
});

test('a directory created after target validation survives the rename race',async t=>{
  const {root,store}=await fixture(t);await fs.mkdir(path.join(root,'source'));await write(root,'source/keep.md','source');
  const target=path.join(root,'target'), originalMkdir=fs.mkdir, originalRename=fs.rename;
  if(process.platform==='win32') t.mock.method(fs,'rename',async(from,to)=>{await originalMkdir(to);return originalRename(from,to);});
  else t.mock.method(fs,'mkdir',async(name,...args)=>{if(name===target)await originalMkdir(name);return originalMkdir(name,...args);});
  await assert.rejects(store.operate({action:'rename',path:path.join(root,'source'),name:'target'}));
  assert.equal(await fs.readFile(path.join(root,'source','keep.md'),'utf8'),'source');
  assert.equal((await fs.stat(target)).isDirectory(),true);assert.deepEqual(await fs.readdir(target),[]);
});

test('a failed unlink after exclusive file move keeps both copies instead of deleting data',async t=>{
  const {root,store}=await fixture(t);await write(root,'source.md','source');
  const source=path.join(root,'source.md'), originalUnlink=fs.unlink;
  t.mock.method(fs,'unlink',async file=>{if(file===source)throw Error('file is busy');return originalUnlink(file);});
  await assert.rejects(store.operate({action:'rename',path:source,name:'target.md'}),/目标副本已保留/);
  assert.equal(await fs.readFile(source,'utf8'),'source');assert.equal(await fs.readFile(path.join(root,'target.md'),'utf8'),'source');
});

test('trash can only call the supplied system operation on a verified non-root path and never falls back to delete',async t=>{
  const {root,outside,store}=await fixture(t);await write(root,'keep.md','important');
  let called='';
  await assert.rejects(store.operate({action:'trash',path:root},async()=>{called='bad';}),/根目录/);
  await assert.rejects(store.operate({action:'trash',path:outside},async()=>{called='bad';}),/工作区/);
  await assert.rejects(store.operate({action:'trash',path:path.join(root,'keep.md')}),/回收站不可用/);
  await assert.rejects(store.operate({action:'trash',path:path.join(root,'keep.md')},async file=>{called=file;throw Error('OS trash unavailable');}),/OS trash unavailable/);
  assert.equal(called,path.join(root,'keep.md'));assert.equal(await fs.readFile(called,'utf8'),'important');
});

test('symlinks and junctions are excluded from reads, search, destination and recursive mutation',async t=>{
  const {root,outside,store}=await fixture(t);await write(outside,'secret.md','secret');await fs.mkdir(path.join(root,'notes'));
  try{await fs.symlink(outside,path.join(root,'jump'),process.platform==='win32'?'junction':'dir');await fs.symlink(path.join(outside,'secret.md'),path.join(root,'notes','linked.md'),'file');}
  catch(error){if(error.code==='EPERM'){t.skip('File symlinks require permission on this Windows account');return;}throw error;}
  assert.equal((await store.snapshot()).entries.length,0);
  assert.equal((await store.search('secret')).matches.length,0);
  await assert.rejects(store.operate({action:'create-file',path:path.join(root,'jump'),name:'bad.md'}),/符号链接/);
  await assert.rejects(store.operate({action:'copy',path:path.join(root,'notes'),destination:root,name:'copy'}),/符号链接/);
  await assert.rejects(store.operate({action:'trash',path:path.join(root,'jump')},()=>Promise.resolve()),/符号链接/);
  assert.equal(await fs.readFile(path.join(outside,'secret.md'),'utf8'),'secret');
});

test('replacing the selected root with a junction does not retain filesystem authorization',async t=>{
  const {root,outside,store}=await fixture(t);await fs.rename(root,`${root}-old`);
  try{await fs.symlink(outside,root,process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM'){t.skip('Symlink permission');return;}throw error;}
  await assert.rejects(store.snapshot(),/位置已改变/);
  await assert.rejects(store.operate({action:'create-file',path:root,name:'bad.md'}),/位置已改变/);
  assert.deepEqual(await fs.readdir(outside),[]);
});

test('workspace search reports UTF-8 line/column, case selection, bounded results and excludes invalid text',async t=>{
  const {root,store}=await fixture(t);await fs.mkdir(path.join(root,'.git'));
  await write(root,'中文.md','\uFEFF# 标题\r\nAlpha 中文词\r\nalpha 中文词\r\n');await write(root,'.git/private.md','Alpha');await write(root,'binary.md',Buffer.from([0xff,0xfe,0x00]));
  const insensitive=await store.search('alpha');assert.equal(insensitive.matches.length,2);assert.equal(insensitive.matches[0].line,2);assert.equal(insensitive.matches[0].column,1);assert.equal(insensitive.skipped,1);
  assert.equal((await store.search('Alpha',true)).matches.length,1);assert.equal((await store.search('中文词')).matches[0].column,7);
  await write(root,'many.md',Array.from({length:250},()=> 'needle').join('\n'));
  const capped=await store.search('needle');assert.equal(capped.matches.length,200);assert.equal(capped.truncated,true);
  await assert.rejects(store.search(''));await assert.rejects(store.search('x'.repeat(257)));
});

test('relative links resolve spaces, Unicode, fragments and extensionless Markdown within the boundary',async t=>{
  const {root,outside,store}=await fixture(t);await fs.mkdir(path.join(root,'notes'));
  await write(root,'start.md','# Start');await write(root,'notes/中文 文稿.md','# 标题');await write(outside,'secret.md','secret');
  assert.deepEqual(await store.resolveLink('notes/%E4%B8%AD%E6%96%87%20%E6%96%87%E7%A8%BF.md#%E6%A0%87%E9%A2%98',path.join(root,'start.md')),{path:path.join(root,'notes','中文 文稿.md'),anchor:'标题'});
  assert.equal((await store.resolveLink('../start',path.join(root,'notes','中文 文稿.md'))).path,path.join(root,'start.md'));
  assert.equal((await store.resolveLink('#local',path.join(root,'start.md'))).anchor,'local');
  for(const href of ['../outside/secret.md','%2e%2e/outside/secret.md','https://example.test/a.md','file:///secret.md','//server/share.md','broken%2']) await assert.rejects(store.resolveLink(href,path.join(root,'start.md')));
});

test('external status detects change/deletion without modifying file contents',async t=>{
  const {root}=await fixture(t);const file=path.join(root,'test.md');await write(root,'test.md','old');
  const revision=crypto.createHash('sha256').update('old').digest('hex');
  assert.equal((await documentStatus(file,revision)).state,'unchanged');
  await write(root,'test.md','new');assert.equal((await documentStatus(file,revision)).state,'changed');assert.equal(await fs.readFile(file,'utf8'),'new');
  await fs.unlink(file);assert.equal((await documentStatus(file,revision)).state,'missing');
});

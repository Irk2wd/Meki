'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore, restoreRecentFolders, MAX_RECENT_FOLDERS, MAX_PINNED_FOLDERS } = require('../electron/file-store.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moye-navigation-')));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const store = new FileStore(root); await store.init(); return {root,store};
}
const folder = (root, name) => path.join(root, name);

test('recent folder migration validates, deduplicates and bounds stored paths without reading locations', async t => {
  const {root,store} = await fixture(t);
  const recentFile = {path:folder(root,'kept.md'),name:'kept.md'};
  await fs.writeFile(store.statePath, JSON.stringify({recentFiles:[recentFile],recentFolders:[null,{path:'relative'},...Array.from({length:30},(_,i)=>({path:folder(root,`folder${i}`),name:'injected',pinned:true,lastOpened:i})),{path:folder(root,'folder0'),pinned:true,lastOpened:99}]}));
  await store.init();
  assert.equal(store.metadata.recentFolders.length,MAX_RECENT_FOLDERS);
  assert.equal(store.metadata.recentFolders.filter(entry=>entry.pinned).length,MAX_PINNED_FOLDERS);
  assert.equal(new Set(store.metadata.recentFolders.map(entry=>entry.path)).size,MAX_RECENT_FOLDERS);
  assert.ok(store.metadata.recentFolders.every(entry=>entry.name===path.basename(entry.path)));
  assert.deepEqual(store.metadata.recentFiles,[recentFile]);
  assert.equal(await fs.stat(folder(root,'folder0')).catch(()=>null),null);
  const old = new FileStore(folder(root,'legacy')); await old.init(); assert.deepEqual(old.metadata.recentFolders,[]);
  const huge = Array.from({length:20},(_,i)=>({path:folder(root,`${i}${'界'.repeat(30000)}`)}));
  assert.ok(Buffer.byteLength(JSON.stringify(restoreRecentFolders(huge))) < 129 * 1024);
});

test('recent folders keep pinned locations while pruning oldest records and preserve settings and recent files', async t => {
  const {root,store} = await fixture(t); const pinned = folder(root,'pinned');
  await store.updateMetadata({recentFiles:[{path:folder(root,'document.md'),name:'document.md'}]});
  await store.changeRecentFolders('remember',pinned); await store.changeRecentFolders('pin',pinned);
  for(let i=0;i<25;i++) await store.changeRecentFolders('remember',folder(root,`folder${i}`));
  const records=store.metadata.recentFolders;
  assert.equal(records.length,20); assert.equal(records[0].path,pinned); assert.equal(records[1].path,folder(root,'folder24'));
  assert.ok(!records.some(entry=>entry.path===folder(root,'folder0')));
  await Promise.all([store.changeRecentFolders('remember',folder(root,'concurrent')),store.updateSettings({fontSize:22}),store.changeRecentFolders('unpin',pinned)]);
  assert.equal(store.metadata.settings.fontSize,22); assert.equal(store.metadata.recentFiles.length,1);
  assert.ok(store.metadata.recentFolders.some(entry=>entry.path===folder(root,'concurrent')));
  await store.changeRecentFolders('pin',pinned); await store.changeRecentFolders('clear');
  assert.deepEqual(store.metadata.recentFolders.map(entry=>entry.path),[pinned]);
  assert.equal(store.metadata.workspaceRoot,folder(root,'concurrent'));
  const restored=new FileStore(root); await restored.init(); assert.deepEqual(restored.metadata.recentFolders,store.metadata.recentFolders);
  await store.changeRecentFolders('remove',pinned); assert.deepEqual(store.metadata.recentFolders,[]); assert.equal(store.metadata.recentFiles.length,1);
});

test('recent folder changes reject unknown paths, invalid operations and excess pins before committing', async t => {
  const {root,store}=await fixture(t);
  for(let i=0;i<11;i++) await store.changeRecentFolders('remember',folder(root,`folder${i}`));
  for(let i=0;i<10;i++) await store.changeRecentFolders('pin',folder(root,`folder${i}`));
  const before=await fs.readFile(store.statePath,'utf8');
  await assert.rejects(store.changeRecentFolders('pin',folder(root,'folder10')),/10/);
  await assert.rejects(store.changeRecentFolders('pin',folder(root,'unknown')),/最近记录/);
  await assert.rejects(store.changeRecentFolders('clear',root));
  await assert.rejects(store.changeRecentFolders('forget',root));
  await assert.rejects(store.changeRecentFolders('remember','../bad'));
  assert.equal(await fs.readFile(store.statePath,'utf8'),before);
});

const entries=[
  {path:'/root/notes',parentPath:'/root',name:'notes',relativePath:'notes',kind:'directory',modifiedAt:1,size:0},
  {path:'/root/notes/sub',parentPath:'/root/notes',name:'sub',relativePath:'notes/sub',kind:'directory',modifiedAt:2,size:0},
  {path:'/root/notes/sub/a.md',parentPath:'/root/notes/sub',name:'a.md',relativePath:'notes/sub/a.md',kind:'file',modifiedAt:3,size:0},
  {path:'/root/notes/b.md',parentPath:'/root/notes',name:'b.md',relativePath:'notes/b.md',kind:'file',modifiedAt:4,size:0},
  {path:'/root/z.md',parentPath:'/root',name:'z.md',relativePath:'z.md',kind:'file',modifiedAt:5,size:0},
];
test('visible tree declares sibling semantics, respects sorting/filtering and removes collapsed descendants',async()=>{
  const {navigationRows}=await import('../src/workspace-navigation.ts');
  const rows=navigationRows(entries,'/root',new Set(),'name');
  assert.deepEqual(rows.map(row=>[row.level,row.position,row.size]),[[1,1,2],[2,1,2],[3,1,1],[2,2,2],[1,2,2]]);
  assert.deepEqual(navigationRows(entries,'/root',new Set(['/root/notes']),'name').map(row=>row.entry.path),['/root/notes','/root/z.md']);
  assert.deepEqual(navigationRows(entries,'/root',new Set(),'name','A.MD').map(row=>[row.entry.path,row.level,row.position,row.size]),[['/root/notes/sub/a.md',1,1,1]]);
});
test('tree keyboard follows visible rows and opens/collapses directories without activating files on focus',async()=>{
  const {navigationRows,navigationKey}=await import('../src/workspace-navigation.ts');
  const collapsed=new Set(), rows=navigationRows(entries,'/root',collapsed,'name');
  assert.deepEqual(navigationKey(rows,'/root/notes','ArrowRight',collapsed,false),{focus:'/root/notes/sub'});
  assert.deepEqual(navigationKey(rows,'/root/notes/sub/a.md','ArrowLeft',collapsed,false),{focus:'/root/notes/sub'});
  assert.deepEqual(navigationKey(rows,'/root/notes','ArrowLeft',collapsed,false),{toggle:'/root/notes'});
  assert.deepEqual(navigationKey(rows,'/root/z.md','Home',collapsed,false),{focus:'/root/notes'});
  assert.deepEqual(navigationKey(rows,'/root/notes','End',collapsed,false),{focus:'/root/z.md'});
  assert.deepEqual(navigationKey(rows,'/root/z.md','ArrowDown',collapsed,false),{focus:'/root/z.md'});
  assert.deepEqual(navigationKey(rows,'/root/z.md','Enter',collapsed,false),{open:'/root/z.md'});
  assert.deepEqual(navigationKey(rows,'/root/z.md','F2',collapsed,false),{rename:'/root/z.md'});
  assert.deepEqual(navigationKey(rows,'/root/notes','ArrowRight',collapsed,true),{toggle:'/root/notes'});
});
test('tree focus survives refresh/reorder, falls back to visible parents, and handles empty trees',async()=>{
  const {navigationRows,retainNavigationPath}=await import('../src/workspace-navigation.ts');
  const old=navigationRows(entries,'/root',new Set(),'name'), selected='/root/notes/sub/a.md';
  assert.equal(retainNavigationPath(selected,[...old].reverse(),old),selected);
  assert.equal(retainNavigationPath(selected,navigationRows(entries,'/root',new Set(['/root/notes']),'name'),old),'/root/notes');
  assert.equal(retainNavigationPath(selected,navigationRows(entries.filter(entry=>entry.path!==selected),'/root',new Set(),'name'),old),'/root/notes/sub');
  assert.equal(retainNavigationPath(selected,[],old),'');
});

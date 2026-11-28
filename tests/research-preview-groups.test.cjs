'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {PreviewService} = require('../electron/research-preview-service.cjs');
const {validateCatalog} = require('../electron/research-preview-catalog.cjs');
const {groupHost} = require('./research-group-host.cjs');

const catalogPath = '/_mekir/accounts/member.json';
async function setup(t) {
  const host = await groupHost();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'mekir-selective-'));
  t.after(async () => { await host.close(); await fs.rm(dir,{recursive:true,force:true}); });
  const credentials = {seal: async p => Buffer.from(p).toString('base64'), open: async v => Buffer.from(v,'base64').toString()};
  const restart = () => new PreviewService(dir,{credentials}).init();
  return {host, dir, restart, service:await restart(), login:{url:host.url,username:'member',password:'test-only'}};
}

test('discovering group memberships only reads the catalog; pulling one shared project downloads one snapshot and its own media',async t => {
  const {host,service,restart,dir,login} = await setup(t);
  const account = await service.accounts.login(login);
  assert.equal(account.catalog.groups.length,2);
  assert.deepEqual(host.calls,[catalogPath]);
  assert.equal(account.secret,undefined);
  assert.equal(JSON.stringify(service.accounts.list()).includes('test-only'),false);
  assert.deepEqual(service.readers(),[]);
  await service.accounts.refresh(account.id);
  assert.deepEqual(host.calls,[catalogPath,catalogPath]);
  host.calls.length=0;
  const downloads = await service.accounts.pull(account.id,['forest','forest']);
  assert.deepEqual(downloads,{pulled:['forest'],errors:[]});
  assert.deepEqual(host.calls.map(p => p.split('/')[1]),['_mekir','trees','trees','trees']);
  const [reader] = service.readers();
  assert.equal(reader.auto,false);
  assert.equal(reader.projectId,'forest');
  assert.equal((await fs.readdir(dir,{withFileTypes:true})).filter(f => f.isDirectory()).length,1);
  const reloaded = await restart();
  assert.deepEqual(reloaded.readers(),service.readers());
  assert.equal((await reloaded.cached(reader.id)).snapshot.project.title,'森林树冠');
  await reloaded.accounts.setAuto(reader,true);
  assert.equal(reloaded.reader(reader.id).auto,true);
  await reloaded.accounts.refreshProject(reader);
  assert.equal(host.calls.filter(p => p.includes('/media/')).length,1);
  assert.equal(host.calls.some(p => p.startsWith('/camera/')),false);
  await reloaded.remove(reader.id);
  assert.equal(reloaded.accounts.list()[0].catalog.projects.length,2);
  assert.deepEqual(reloaded.readers(),[]);
  await assert.rejects(fs.access(reloaded.cache(reader.id).dir),{code:'ENOENT'});
  await reloaded.accounts.pull(account.id,['trail']);
  await reloaded.accounts.logout(account.id);
  assert.deepEqual((await restart()).accounts.list(),[]);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('a failed project does not affect other selections; losing one group keeps shared access, and losing the last drops its cache',async t => {
  const {host,service,login} = await setup(t);
  const account = await service.accounts.login(login);
  const head = host.files.get('/camera/latest.json');
  host.files.delete('/camera/latest.json');
  const batch = await service.accounts.pull(account.id,['trail','forest']);
  assert.deepEqual(batch.pulled,['forest']);
  assert.equal(batch.errors[0].projectId,'trail');
  assert.equal(service.readers().length,1);
  host.files.set('/camera/latest.json',head);
  await service.accounts.pull(account.id,['trail']);
  const [forest,trail] = service.readers();
  const full = host.state.catalog;
  host.state.catalogStatus = 503;
  await assert.rejects(service.accounts.refresh(account.id),/503/);
  assert.ok(await service.cached(trail.id));
  host.state.catalogStatus = 200;
  host.state.catalog = {...full,groups:[full.groups[1]],projects:[full.projects[0]]};
  const dropped = [];
  service.on('readers-removed', ids => dropped.push(...ids));
  await service.accounts.refresh(account.id);
  assert.deepEqual(dropped,[trail.id]);
  assert.ok(await service.cached(forest.id));
  await assert.rejects(service.cached(trail.id));
  host.calls.length=0;
  assert.deepEqual((await service.accounts.pull(account.id,['trail'])).pulled,[]);
  assert.deepEqual(host.calls,[catalogPath]);
  host.state.catalogStatus = 401;
  await assert.rejects(service.accounts.refresh(account.id),/401/);
  assert.deepEqual(service.accounts.list()[0].catalog.groups,[]);
  assert.equal(service.accounts.list()[0].needsLogin,true);
  assert.deepEqual(dropped,[trail.id,forest.id]);
  assert.deepEqual(service.readers(),[]);
});

test('existing direct subscriptions keep their ID and cached files through account adoption and a server move',async t => {
  const {host,service,login} = await setup(t);
  const direct = await service.subscribe({...login,url:host.url+'trees/'});
  host.calls.length=0;
  const a = await service.accounts.upgrade(direct.id);
  assert.deepEqual(host.calls,[catalogPath]);
  assert.equal(service.reader(direct.id).accountId,a.id);
  assert.equal(service.readers().length,1);
  const next = await groupHost(); t.after(() => next.close());
  await assert.rejects(service.accounts.login({url:next.url,username:'member'},a.id),/密码/);
  next.state.catalog.library = {id:'different',title:'另一项目库'};
  await assert.rejects(service.accounts.login({...login,url:next.url},a.id),/ID/);
  next.state.catalog.library = host.state.catalog.library;
  await service.accounts.login({...login,url:next.url},a.id);
  assert.equal(service.reader(direct.id).url,next.url+'trees/');
  assert.ok(await service.cached(direct.id));
  assert.deepEqual(next.calls,[catalogPath,catalogPath]);
  const {projects,groups} = host.state.catalog;
  for (const directory of ['../trees','https://another.example','a/b','%2fsecret']) {
    assert.throws(() => validateCatalog({...host.state.catalog,projects:[{...projects[0],directory},projects[1]]}));
  }
  assert.throws(() => validateCatalog({...host.state.catalog,groups:[{...groups[0],projects:['unknown']}]}));
});

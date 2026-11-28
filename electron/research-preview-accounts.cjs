'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {assert} = require('./research-model.cjs');
const {readCatalog, accountName} = require('./research-preview-catalog.cjs');
const {endpoint} = require('./research-preview-dav.cjs');
const {validId} = require('./research-preview-model.cjs');

const denied = error => error.status === 401 || error.status === 403;
const projectUrl = (account, project) => new URL(project.directory + '/', account.url).href;
const emptyCatalog = catalog => ({...catalog, groups:[], projects:[]});

class PreviewAccounts {
  constructor(service) { this.service = service; }

  accounts() { return [...this.service.connections.values()].filter(c => c.role === 'account'); }
  list() { return this.accounts().map(a => this.service.info(a)); }
  get(id) {
    const account = this.service.connections.get(id);
    assert(account?.role === 'account', '找不到这个订阅账号。');
    return account;
  }

  connection(account, project, local) {
    return {id:local.id, role:'reader', accountId:account.id, projectId:project.id,
      title:project.title, url:projectUrl(account,project), username:account.username,
      publishedAt:local.publishedAt || '', auto:local.auto === true};
  }
  readers() {
    return this.accounts().flatMap(account => {
      const projects = new Map(account.catalog.projects.map(p => [p.id,p]));
      return account.selected.flatMap(local => {
        const project = projects.get(local.projectId);
        return project ? [this.connection(account,project,local)] : [];
      });
    });
  }
  reader(id) { return this.readers().find(c => c.id === id); }

  async purge(ids) {
    if (!ids.length) return;
    this.service.emit('readers-removed', ids);
    for (const id of ids) await fs.rm(this.service.cache(id).dir, {recursive:true,force:true});
  }
  async retireLegacy(id) {
    await this.service.run(id, async () => {
      if (this.service.connections.get(id)?.role !== 'reader') return;
      await fs.rm(path.join(this.service.directory,id + '.json'), {force:true});
      this.service.connections.delete(id);
    });
  }

  async reconcile(account, catalog, needsLogin = false) {
    assert(!account.catalog || account.catalog.library.id === catalog.library.id, '订阅库 ID 已改变，请核对服务器地址。');
    const projects = new Map(catalog.projects.map(p => [p.id,p]));
    const selected = account.selected.filter(c => projects.has(c.projectId));
    const removed = account.selected.filter(c => !projects.has(c.projectId)).map(c => c.id);
    const adopted = [];
    // Reuse verified downloads made by this same user at this exact project URL.
    for (const direct of this.service.connections.values()) {
      if (direct.role !== 'reader' || direct.username !== account.username) continue;
      const project = projects.get(direct.projectId);
      if (!project || projectUrl(account,project) !== direct.url || selected.some(s => s.projectId === project.id)) continue;
      selected.push({id:direct.id,projectId:project.id,publishedAt:direct.publishedAt,auto:false});
      adopted.push(direct.id);
    }
    const next = {...account, catalog, selected, needsLogin};
    if (JSON.stringify(this.service.connections.get(account.id)) !== JSON.stringify(next)) await this.service.save(next);
    for (const id of adopted) await this.retireLegacy(id);
    await this.purge(removed);
    return next;
  }

  async check(account) {
    try {
      const catalog = await readCatalog(await this.service.dav(account), account.username);
      return await this.reconcile(account, catalog);
    } catch (error) {
      if (denied(error)) await this.reconcile(account, emptyCatalog(account.catalog), true);
      throw error;
    }
  }
  refresh(id) {
    return this.service.run('account:' + id, async () => this.service.info(await this.check(this.get(id))));
  }

  login(input, existingId, legacy) {
    const url = endpoint(input.url), username = input.username?.trim();
    assert(accountName(username), '请输入有效的订阅账号。');
    return this.service.run('login:' + JSON.stringify([url,username]), () => {
      const found = this.accounts().find(a => a.url === url && a.username === username);
      const id = existingId || found?.id || randomUUID();
      return this.service.run('account:' + id, async () => {
        const old = existingId ? this.get(id) : this.service.connections.get(id);
        assert(!found || found.id === id, '这个账号已连接到该服务器。');
        assert(!old || old.username === username, '切换用户名时请添加另一个订阅账号。');
        const credentials = legacy ? {url,username,secret:legacy.secret} : await this.service.connection(old,input);
        const account = {...old,...credentials,id,role:'account',selected:old?.selected || []};
        const catalog = await readCatalog(await this.service.dav(account),username);
        if (legacy) assert(catalog.projects.some(p => p.id === legacy.projectId && projectUrl(account,p) === legacy.url),
          '当前项目未登记在这个账号的订阅组内。');
        return this.service.info(await this.reconcile(account,catalog));
      });
    });
  }
  upgrade(readerId) {
    const direct = this.service.reader(readerId);
    if (direct.accountId) return this.refresh(direct.accountId);
    return this.login({url:new URL('../',direct.url).href,username:direct.username}, undefined, direct);
  }

  async removeSelection(account, id) {
    const selected = account.selected.filter(s => s.id !== id);
    if (selected.length === account.selected.length) return;
    await this.service.save({...account, selected});
    await this.purge([id]);
  }

  async download(account, projectId) {
    const project = account.catalog.projects.find(p => p.id === projectId);
    assert(project, '此账号已无权访问该项目。');
    const old = account.selected.find(s => s.projectId === projectId);
    const local = old || {id:randomUUID(), projectId, auto:false};
    try {
      const state = await this.service.pull(this.connection(account,project,local));
      if (!old || old.publishedAt !== state.pointer.publishedAt) {
        const updated = {...local,publishedAt:state.pointer.publishedAt};
        await this.service.save({...account,selected:[...account.selected.filter(s => s.id !== local.id),updated]});
      }
      return state;
    } catch (error) {
      if (error.status === 401) await this.reconcile(account,emptyCatalog(account.catalog),true);
      else if (denied(error) && old) await this.removeSelection(account,local.id);
      if (!old) await fs.rm(this.service.cache(local.id).dir,{recursive:true,force:true});
      throw error;
    }
  }

  pull(id, projectIds) {
    assert(Array.isArray(projectIds) && projectIds.length && projectIds.every(validId), '请选择要拉取的项目。');
    return this.service.run('account:' + id, async () => {
      await this.check(this.get(id));
      const pulled = [], errors = [];
      for (const projectId of new Set(projectIds)) {
        try {
          await this.download(this.get(id), projectId);
          pulled.push(projectId);
        } catch (error) {
          if (error.status === 401) throw error;
          errors.push({projectId, message:error.message});
        }
      }
      return {pulled,errors};
    });
  }
  refreshProject(c) {
    return this.service.run('account:' + c.accountId, async () => {
      const account = await this.check(this.get(c.accountId));
      assert(account.selected.some(s => s.id === c.id), '此项目已从本机项目列表移除。');
      return this.download(account,c.projectId);
    });
  }
  removeProject(c) {
    return this.service.run('account:' + c.accountId, () => this.removeSelection(this.get(c.accountId),c.id));
  }
  setAuto(c, auto) {
    assert(typeof auto === 'boolean','无效的更新设置。');
    return this.service.run('account:' + c.accountId, async () => {
      const account = this.get(c.accountId);
      const local = account.selected.find(s => s.id === c.id);
      assert(local,'此项目已从本机项目列表移除。');
      await this.service.save({...account,selected:account.selected.map(s => s === local ? {...s,auto} : s)});
      return this.service.info(this.reader(c.id));
    });
  }
  logout(id) {
    return this.service.run('account:' + id, async () => {
      const account = this.get(id);
      await fs.rm(path.join(this.service.directory,id + '.json'),{force:true});
      this.service.connections.delete(id);
      await this.purge(account.selected.map(c => c.id));
    });
  }
}
module.exports = { PreviewAccounts, denied };

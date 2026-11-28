'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {atomicWrite, digest, pathKey, readBytes} = require('./file-store.cjs');
const {ResearchStore} = require('./research-store.cjs');
const {assert, RECORD_FILE} = require('./research-model.cjs');
const {bindingPath} = require('./research-evidence.cjs');
const {evidenceImageMime} = require('./research-comparison.mjs');
const {projectToday} = require('./research-phases.mjs');
const {projectPreview, validId, validHash, imageFormat, maxSnapshot, maxThumbnail, maxPinned, mediaHashes, validatePointer, validateSnapshot} = require('./research-preview-model.cjs');
const {PreviewDAV, endpoint} = require('./research-preview-dav.cjs');

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const publisherId = root => digest(Buffer.from(pathKey(root)));
const privateDir = dir => fs.mkdir(dir, {recursive:true, mode:0o700});
const writeJSON = (file, data) => atomicWrite(file, Buffer.from(JSON.stringify(data)));
const absent = e => { if (e.code !== 'ENOENT') throw e; return null; };

async function stamp(file) {
  const st = await fs.stat(file,{bigint:true}).catch(absent);
  return st && `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}
async function fingerprint(store, images) {
  const files = [store.manifestPath, bindingPath(store.root), ...images];
  if (store.indexPath) files.push(store.indexPath);
  for (const directory of store.recordDirectories) {
    const names = await fs.readdir(directory).catch(absent);
    for (const name of names || []) if (RECORD_FILE.test(name)) files.push(path.join(directory,name));
  }
  const entries = [];
  for (const file of files.sort()) entries.push([file, await stamp(file)]);
  return digest(Buffer.from(JSON.stringify(entries)));
}
async function nativeThumbnail(file) {
  const {nativeImage} = require('electron');
  const image = await nativeImage.createThumbnailFromPath(file.path, {width:480,height:480});
  assert(!image.isEmpty(), '无法生成可视化缩略图。');
  const bitmap = image.toBitmap();
  // Keep transparent pixels for overlays and sharp edges for indexed graphics.
  for (let alpha = 3; alpha < bitmap.length; alpha += 4) if (bitmap[alpha] !== 255) return image.toPNG();
  const jpeg = image.toJPEG(80), png = image.toPNG();
  return jpeg.length < png.length ? jpeg : png;
}
const vault = {
  async seal(password) {
    const {safeStorage} = require('electron');
    assert(await safeStorage.isAsyncEncryptionAvailable(), '系统凭据存储暂不可用。');
    return (await safeStorage.encryptStringAsync(password)).toString('base64');
  },
  async open(value) {
    return value ? (await require('electron').safeStorage.decryptStringAsync(Buffer.from(value,'base64'))).result : '';
  },
};

class PreviewService {
  constructor(directory, {credentials = vault, thumbnail = nativeThumbnail} = {}) {
    this.directory = directory;
    this.credentials = credentials;
    this.thumbnail = thumbnail;
    this.connections = new Map();
    this.queues = new Map();
    this.inputs = new Map();
    this.errors = new Map();
  }
  async init() {
    await privateDir(this.directory);
    for (const f of await fs.readdir(this.directory)) {
      if (!/^(?:[a-f0-9-]{36}|[a-f0-9]{64})\.json$/.test(f)) continue;
      try {
        const c = JSON.parse(await fs.readFile(path.join(this.directory,f),'utf8'));
        if (f === `${c.id}.json` && (c.role === 'reader' ? uuid.test(c.id) : c.role === 'publisher' && validHash(c.id))) this.connections.set(c.id,c);
      } catch (error) { console.warn('Could not load remote preview connection',f,error.code || error.name); }
    }
    return this;
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const c of this.connections.values()) {
        if (c.role !== 'publisher' || !c.auto || this.queues.has(c.id)) continue;
        const delay = this.errors.get(c.id)?.retryAt;
        if (delay && Date.now() < delay) continue;
        await this.run(c.id, async () => {
          const store = await ResearchStore.open(c.root);
          assert(store, '本地项目目录暂不可用。');
          const last = this.inputs.get(c.id);
          if (last && last.day === projectToday(last.timezone) && last.signature === await fingerprint(store,last.images)) return;
          await this.publish(store, c);
        }).catch(() => {});
      }
    } finally { this.ticking = false; }
  }
  run(id, action) {
    const promise = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(id,promise);
    return promise.then(value => { this.errors.delete(id); return value; }, error => {
      this.errors.set(id,{message:error.message, retryAt:Date.now()+60000}); throw error;
    }).finally(() => { if (this.queues.get(id) === promise) this.queues.delete(id); });
  }
  info(c) {
    if (!c) return null;
    const {secret, root, ...view} = c;
    return {...view, error:this.errors.get(c.id)?.message || ''};
  }
  publisher(root) { return this.info(this.connections.get(publisherId(root))); }
  readers() { return [...this.connections.values()].filter(c => c.role === 'reader').map(c => this.info(c)); }
  reader(id) {
    const c = this.connections.get(id);
    assert(c?.role === 'reader', '找不到这项远程订阅。');
    return c;
  }
  async connection(old, input) {
    const url = endpoint(input.url);
    const username = input.username?.trim() || '';
    assert(typeof username === 'string' && username.length <= 256 && !/[:\r\n]/.test(username),'无效的 WebDAV 用户名。');
    assert(input.password === undefined || (typeof input.password === 'string' && input.password.length <= 4096),'无效的 WebDAV 密码。');
    const sameLogin = old?.url === url && old.username === username;
    let secret;
    if (input.password) secret = await this.credentials.seal(input.password);
    else if (sameLogin) secret = old.secret;
    else if (username) throw Error('请为这个地址填写密码。');
    return {...old,url,username,secret};
  }
  async dav(c) { return new PreviewDAV(c.url, c.username, await this.credentials.open(c.secret)); }
  async save(c) {
    await writeJSON(path.join(this.directory,`${c.id}.json`),c);
    this.connections.set(c.id,c);
  }
  configurePublisher(store,input) {
    const id = publisherId(store.root);
    return this.run(id,async () => {
      const old = this.connections.get(id);
      const c = {...await this.connection(old,input),id,role:'publisher',root:store.root,auto:input.auto === true,pinned:input.pinned || []};
      assert(Array.isArray(c.pinned) && c.pinned.length <= maxPinned && c.pinned.every(validId),'精选记录最多 24 篇。');
      await this.publish(store,c,true);
      return this.info(this.connections.get(id));
    });
  }
  pause(root) {
    const id = publisherId(root);
    return this.run(id,async () => {
      const c = this.connections.get(id);
      assert(c?.role === 'publisher','尚未配置发布地址。');
      await this.save({...c,auto:false});
    });
  }
  async publish(store,c,verifyExisting = false) {
    const known = this.inputs.get(c.id);
    const images = new Map();
    const lock = path.join(store.root,'.meki-research.lock');
    const busy = '项目正在更新，请稍后重试。';
    assert(!await stamp(lock), busy);
    const before = await fingerprint(store,known?.images || []);
    const built = await projectPreview(store,c.pinned,async id => {
      const {file} = await store.evidenceFile(id);
      assert(evidenceImageMime(file.path) && file.size <= 64*1024*1024,'请使用大小在 64 MiB 以内的对比图片。');
      images.set(file.path,await stamp(file.path));
      return this.thumbnail(file);
    });
    assert(!c.projectId || built.snapshot.project.id === c.projectId, '本地目录的项目 ID 已更改。');
    const paths = [...images.keys()];
    const signature = await fingerprint(store,paths);
    assert(before === await fingerprint(store,known?.images || []) && !await stamp(lock),busy);
    for (const [file,readStamp] of images) assert(readStamp === await stamp(file),busy);
    const pointer = await (await this.dav(c)).publish(built,{verifyExisting});
    await this.save({...c,projectId:pointer.projectId, title:built.snapshot.project.title,publishedAt:pointer.publishedAt});
    this.inputs.set(c.id,{signature,images:paths,day:built.snapshot.asOf,timezone:built.timezone});
  }
  cache(id) {
    const dir = path.join(this.directory,id);
    return {
      dir, file:path.join(dir,'current.json'),
      async get(hash) {
        assert(validHash(hash),'Invalid thumbnail ID.');
        const result = await readBytes(path.join(dir,`${hash}.thumb`),maxThumbnail).catch(absent);
        return result && digest(result.bytes) === hash ? result.bytes : null;
      },
      put(hash,bytes) { return atomicWrite(path.join(dir,`${hash}.thumb`),bytes); },
    };
  }
  async cached(id) {
    this.reader(id);
    return this.readCache(id);
  }
  async readCache(id) {
    const saved = await readBytes(this.cache(id).file,maxSnapshot+4096).catch(absent);
    if (!saved) return null;
    try {
      const state = JSON.parse(saved.bytes);
      validatePointer(state.pointer);
      validateSnapshot(state.snapshot,state.pointer.projectId);
      return state;
    } catch { return null; }
  }
  async pull(c) {
    const cache = this.cache(c.id);
    await privateDir(cache.dir);
    const old = await this.readCache(c.id);
    const state = await (await this.dav(c)).download(c.projectId,cache,old);
    if (state !== old) await writeJSON(cache.file,state);
    await this.save({...c,title:state.snapshot.project.title,projectId:state.pointer.projectId,publishedAt:state.pointer.publishedAt});
    const keep = mediaHashes(state.snapshot);
    for (const f of await fs.readdir(cache.dir)) {
      if (/^[\da-f]{64}\.(thumb|png)$/.test(f) && (f.endsWith('.png') || !keep.has(f.slice(0,64)))) await fs.unlink(path.join(cache.dir,f)).catch(absent);
    }
    return state;
  }
  subscribe(input,id) {
    if (!id) {
      const url = endpoint(input.url);
      return this.run('subscribe:'+url,() => {
        const existing = [...this.connections.values()].find(c => c.role === 'reader' && c.url === url);
        return this.connectReader(input,existing?.id || randomUUID());
      });
    }
    return this.connectReader(input,this.reader(id).id);
  }
  connectReader(input,id) {
    return this.run(id,async () => {
      const old = this.connections.get(id);
      const c = {...await this.connection(old,input), id, role:'reader'};
      try { await this.pull(c); }
      catch (error) { if (!old && !this.connections.has(id)) await fs.rm(this.cache(id).dir,{recursive:true,force:true}); throw error; }
      return this.info(this.reader(id));
    });
  }
  refresh(id) { return this.run(this.reader(id).id,() => this.pull(this.reader(id))); }
  async image(id,hash) {
    this.reader(id);
    const bytes = await this.cache(id).get(hash);
    return bytes ? `data:image/${imageFormat(bytes)};base64,${bytes.toString('base64')}` : null;
  }
  remove(id) {
    this.reader(id);
    return this.run(id,async () => {
      await fs.rm(path.join(this.directory,`${id}.json`),{force:true});
      this.connections.delete(id);
      await fs.rm(this.cache(id).dir,{recursive:true,force:true});
    });
  }
}

let desktop;
function desktopPreviews() {
  if (!desktop) {
    const {app} = require('electron');
    desktop = new PreviewService(path.join(app.getPath('userData'),'remote-previews')).init().then(service => {
      service.start(); app.once('will-quit',() => service.stop()); return service;
    });
  }
  return desktop;
}
module.exports = {PreviewService, desktopPreviews};

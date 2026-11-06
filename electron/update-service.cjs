'use strict';
const { t } = require('./i18n.mjs');

const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { names, newer, verifyManifest, compatible, releaseInfo, asset, REPOSITORY } = require('./update-policy.cjs');
const { hashFile, atomicJson, regular, directory } = require('./update-runtime.cjs');
const { GithubUpdates } = require('./update-network.cjs');

class UpdateService {
  constructor({ runtime, network = new GithubUpdates(), notify = () => {}, clock = Date.now, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { runtime, network, notify, clock, timers });
    this.preferencesFile = path.join(runtime.root, 'notifications-v1.json');
    this.preferences = { automatic: true, dismissedVersion: null };
    try {
      if (fs.existsSync(this.preferencesFile)) {
        regular(this.preferencesFile, 4096);
        const saved = JSON.parse(fs.readFileSync(this.preferencesFile, 'utf8'));
        if (saved.version !== 1 || typeof saved.automatic !== 'boolean' ||
            saved.dismissedVersion !== null && !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(saved.dismissedVersion)) throw Error('Invalid update notification preferences');
        this.preferences = { automatic: saved.automatic, dismissedVersion: saved.dismissedVersion };
      }
    } catch (error) { this.preferences.automatic = false; console.warn('Meki could not read automatic update preferences:', error.message); }
    this.state = { status: 'idle', currentVersion: runtime.version, latestVersion: null, notes: '', releaseUrl: null, repository: REPOSITORY, kind: null, downloaded: 0, total: 0,
      automatic: this.preferences.automatic, notificationVersion: null,
      message: runtime.message ? t(runtime.message) : t("点击“检查更新”获取最新正式版本。") };
    this.controller = null; this.candidate = null; this.ready = null;
    this.polling = false; this.timer = null; this.lastChecked = null;
  }
  savePreferences() { atomicJson(this.preferencesFile, { version: 1, ...this.preferences }); }
  startAutomatic({ delay = 15000, interval = 6 * 60 * 60 * 1000 } = {}) {
    this.polling = true; this.delay = delay; this.interval = interval; this.schedule(delay);
  }
  stopAutomatic() { this.polling = false; this.timers.clearTimeout(this.timer); this.timer = null; }
  schedule(delay) {
    this.timers.clearTimeout(this.timer); this.timer = null;
    if (!this.polling || !this.state.automatic) return;
    this.timer = this.timers.setTimeout(() => { void this.checkAutomatically(); }, delay);
    this.timer?.unref?.();
  }
  async checkAutomatically() {
    if (!this.polling || !this.state.automatic) return;
    if (this.controller || this.ready) { this.schedule(60000); return; }
    const now = this.clock(), last = this.lastChecked;
    if (last !== null && last <= now && now - last < this.interval) { this.schedule(this.interval - (now - last)); return; }
    try { await this.check(); }
    catch (error) { console.warn('Meki could not check for updates in the background:', error.message); }
    finally { this.schedule(this.interval); }
  }
  setAutomatic(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError(t("自动更新提醒设置无效。"));
    const previous = this.preferences.automatic; this.preferences.automatic = enabled;
    try { this.savePreferences(); } catch (error) { this.preferences.automatic = previous; throw error; }
    const notificationVersion = enabled && this.state.status === 'available' && this.state.latestVersion !== this.preferences.dismissedVersion ? this.state.latestVersion : null;
    const result = this.set({ automatic: enabled, notificationVersion });
    this.schedule(this.delay || 15000); return result;
  }
  dismissNotification(version) {
    if (typeof version !== 'string' || version !== this.state.latestVersion) return this.snapshot();
    this.preferences.dismissedVersion = version;
    try { this.savePreferences(); } catch (error) { console.warn('Meki could not retain the dismissed update reminder:', error.message); }
    return this.set({ notificationVersion: null });
  }
  snapshot() { return { ...this.state }; }
  set(patch) { Object.assign(this.state, patch); this.notify(this.snapshot()); return this.snapshot(); }
  busy() { if (this.controller) throw new Error(t("更新操作正在进行，请先取消或等待完成。")); }
  async check() {
    this.busy(); const controller = this.controller = new AbortController();
    this.candidate = null; this.ready = null;
    this.set({ status: 'checking', latestVersion: null, notes: '', releaseUrl: null, repository: REPOSITORY, kind: null, total: 0, downloaded: 0, notificationVersion: null, message: t("正在检查更新…") });
    try {
      const network = this.network, release = await network.latest(controller.signal, this.runtime.platform);
      const info = releaseInfo(release, network.repository);
      this.set({ repository: network.repository });
      if (!newer(info.version, this.runtime.version)) return this.set({ status: 'current', latestVersion: info.version, notes: info.notes, releaseUrl: info.url, message: t("当前已是最新版本。") });
      const envelope = await network.manifest(asset(release, names(info.version, this.runtime.platform).manifest), controller.signal);
      const manifest = verifyManifest(envelope, this.runtime.key, { version: info.version, platform: this.runtime.platform });
      const kind = compatible(manifest, this.runtime) ? 'payload' : 'installer', file = manifest[kind], download = asset(release, file.name);
      if (download.size !== file.size || download.digest && download.digest !== `sha256:${file.sha256}`) throw new Error(t("发布文件与签名清单不一致。"));
      this.candidate = { envelope, manifest, kind, download, network };
      return this.set({ status: 'available', latestVersion: info.version, notes: info.notes, releaseUrl: info.url, kind, total: file.size,
        notificationVersion: this.state.automatic && this.preferences.dismissedVersion !== info.version ? info.version : null,
        message: kind === 'payload' ? t("有新版本。只下载程序代码，安装后重启生效。") : t("此版本更新了运行环境或应用图标，需要下载安装器。") });
    } catch (error) { return this.set({ status: controller.signal.aborted ? 'idle' : 'error', message: controller.signal.aborted ? t("已取消检查。") : error.message }); }
    finally { this.controller = null; this.lastChecked = this.clock(); }
  }
  async download() {
    this.busy(); if (!this.candidate) throw new Error(t("请先检查更新。"));
    const candidate = this.candidate, { manifest, envelope, kind } = candidate;
    const controller = this.controller = new AbortController(); const file = manifest[kind];
    const temporary = path.join(this.runtime.root, `${crypto.randomUUID()}.download`), unpacked = `${temporary}.unpacked`;
    this.set({ status: 'downloading', downloaded: 0, message: t("正在下载并校验更新…") });
    try {
      await candidate.network.download(candidate.download, file, temporary, controller.signal, (downloaded, total) => this.set({ downloaded, total }));
      if (kind === 'payload') {
        let size = 0; const hash = crypto.createHash('sha256');
        await pipeline(fs.createReadStream(temporary), zlib.createGunzip(), new Transform({ transform(chunk, _encoding, done) {
          size += chunk.length; if (size > manifest.asarSize) return done(new Error(t("程序更新解压后超出预期大小。")));
          hash.update(chunk); done(null, chunk);
        } }), fs.createWriteStream(unpacked, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
        if (size !== manifest.asarSize || hash.digest('hex') !== manifest.asarSha256) throw new Error(t("程序更新校验失败。"));
        const files = this.runtime.paths(manifest.asarSha256);
        if (fs.existsSync(files.archive)) {
          regular(files.archive, manifest.asarSize);
          if (hashFile(files.archive) !== manifest.asarSha256) throw new Error(t("已有更新缓存损坏，请移除更新缓存后重试。"));
        } else await fsp.rename(unpacked, files.archive);
        atomicJson(files.manifest, envelope);
        this.runtime.validate(manifest.asarSha256);
        this.ready = { kind, manifest };
      } else {
        const folder = path.join(this.runtime.root, 'installers'); directory(folder);
        const destination = path.join(folder, file.name);
        if (fs.existsSync(destination)) {
          regular(destination, file.size);
          if (hashFile(destination) !== file.sha256) throw new Error(t("已有安装器缓存损坏，请移除更新缓存后重试。"));
        } else await fsp.rename(temporary, destination);
        this.ready = { kind, manifest, path: destination };
      }
      return this.set({ status: 'ready', message: kind === 'payload' ? t("更新已就绪。重启前会处理未保存的文稿。") : t("安装器已就绪。打开前会处理未保存的文稿。") });
    } catch (error) {
      this.ready = null;
      return this.set({ status: controller.signal.aborted ? 'available' : 'error', downloaded: 0, message: controller.signal.aborted ? t("下载已取消，可以重新下载。") : error.message });
    } finally {
      this.controller = null;
      for (const file of [temporary, unpacked]) await fsp.unlink(file).catch(() => {});
    }
  }
  cancel() { this.controller?.abort(); return this.snapshot(); }
  prepareApply() {
    this.busy(); if (!this.ready || this.state.status !== 'ready') throw new Error(t("请先下载并校验更新。"));
    const ready = this.ready;
    if (ready.kind === 'payload') this.runtime.validate(ready.manifest.asarSha256);
    else if (regular(ready.path, ready.manifest.installer.size).size !== ready.manifest.installer.size || hashFile(ready.path) !== ready.manifest.installer.sha256) throw new Error(t("安装器校验失败。"));
    return ready;
  }
}
module.exports = { UpdateService };

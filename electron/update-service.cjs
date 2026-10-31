'use strict';
const { t } = require('./i18n.mjs');

const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { names, newer, verifyManifest, compatible, releaseInfo, asset, REPOSITORY } = require('./update-policy.cjs');
const { hashFile, atomicJson, regular, directory } = require('./update-runtime.cjs');
const { GithubUpdates } = require('./update-network.cjs');

class UpdateService {
  constructor({ runtime, encryption, network = new GithubUpdates(), cliToken, notify = () => {} }) {
    Object.assign(this, { runtime, encryption, network, notify });
    this.legacyNetwork = network.legacy();
    this.cliToken = cliToken || (async () => (await promisify(execFile)('gh', ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true, timeout: 8000, maxBuffer: 8192 })).stdout.trim());
    this.authFile = path.join(runtime.root, 'auth.json'); this.sessionToken = null; this.auth = { kind: 'none' };
    try { if (fs.existsSync(this.authFile)) { regular(this.authFile, 32768); const auth = JSON.parse(fs.readFileSync(this.authFile, 'utf8')); if (['cli', 'token'].includes(auth.kind)) this.auth = auth; } } catch { /* Invalid credentials can be replaced in the update dialog. */ }
    this.state = { status: 'idle', currentVersion: runtime.version, latestVersion: null, notes: '', releaseUrl: null, repository: REPOSITORY, kind: null, downloaded: 0, total: 0,
      message: runtime.message ? t(runtime.message) : t("点击“检查更新”获取最新正式版本。") };
    this.controller = null; this.candidate = null; this.ready = null;
  }
  snapshot() { return { ...this.state, credential: this.auth.kind, canRemember: this.encryption.available() }; }
  set(patch) { Object.assign(this.state, patch); this.notify(this.snapshot()); return this.snapshot(); }
  busy() { if (this.controller) throw new Error(t("更新操作正在进行，请先取消或等待完成。")); }
  async token() {
    if (this.auth.kind === 'cli') {
      try { const token = await this.cliToken(); if (typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f]/.test(token)) return token; } catch { /* Never return CLI stderr, which may contain account details. */ }
      throw new Error(t("未找到可用的 GitHub CLI 登录。请先登录 gh，或输入访问令牌。"));
    }
    if (this.auth.kind === 'token') {
      if (this.sessionToken) return this.sessionToken;
      try { if (this.auth.encrypted && this.encryption.available()) return this.encryption.decrypt(Buffer.from(this.auth.encrypted, 'base64')); } catch { /* Keychain access may need to be granted again after reinstalling. */ }
    }
    throw new Error(t("这是私有更新仓库，请先连接本机 GitHub 登录或输入访问令牌。"));
  }
  async credentials(input) {
    this.busy();
    if (!input || !['cli', 'token', 'none'].includes(input.kind)) throw new Error(t("无效的更新登录方式。"));
    if (input.kind === 'token' && (typeof input.token !== 'string' || input.token.length < 1 || input.token.length > 4096 || /[\s\x00-\x1f]/.test(input.token) || typeof input.remember !== 'boolean')) throw new Error(t("访问令牌格式无效。"));
    const auth = { kind: input.kind };
    if (input.kind === 'token' && input.remember) {
      if (!this.encryption.available()) throw new Error(t("系统安全存储不可用，请取消“记住此设备”后重试。"));
      auth.encrypted = this.encryption.encrypt(input.token).toString('base64');
    }
    if (input.kind === 'cli') {
      try { const value = await this.cliToken(); if (!value?.trim()) throw new Error(); } catch { throw new Error(t("未找到 GitHub CLI 登录。请先执行 gh auth login，或输入访问令牌。")); }
    }
    atomicJson(this.authFile, input.kind === 'token' && !input.remember ? { kind: 'none' } : auth);
    this.auth = auth; this.sessionToken = input.kind === 'token' ? input.token : null;
    this.candidate = null; this.ready = null;
    return this.set({ status: 'idle', latestVersion: null, notes: '', releaseUrl: null, repository: REPOSITORY, kind: null, total: 0, downloaded: 0, message: input.kind === 'none' ? t("已断开更新仓库登录。") : t("已连接，可以检查更新。") });
  }
  async check() {
    this.busy(); const controller = this.controller = new AbortController();
    this.candidate = null; this.ready = null;
    this.set({ status: 'checking', latestVersion: null, notes: '', releaseUrl: null, repository: REPOSITORY, kind: null, total: 0, downloaded: 0, message: t("正在检查更新…") });
    try {
      let network = this.network, token = null, release;
      try { release = await network.latest(null, controller.signal, this.runtime.platform); }
      catch (error) {
        if (error.code !== 'NO_RELEASE' || this.auth.kind === 'none' || controller.signal.aborted) throw error;
        network = this.legacyNetwork;
        token = await this.token();
        release = await network.latest(token, controller.signal, this.runtime.platform);
      }
      const info = releaseInfo(release, network.repository);
      this.set({ repository: network.repository });
      if (!newer(info.version, this.runtime.version)) return this.set({ status: 'current', latestVersion: info.version, notes: info.notes, releaseUrl: info.url, message: t("当前已是最新版本。") });
      const envelope = await network.manifest(asset(release, names(info.version, this.runtime.platform).manifest), token, controller.signal);
      const manifest = verifyManifest(envelope, this.runtime.key, { version: info.version, platform: this.runtime.platform });
      const kind = compatible(manifest, this.runtime) ? 'payload' : 'installer', file = manifest[kind], download = asset(release, file.name);
      if (download.size !== file.size || download.digest && download.digest !== `sha256:${file.sha256}`) throw new Error(t("发布文件与签名清单不一致。"));
      this.candidate = { envelope, manifest, kind, download, network, authenticated: token !== null };
      return this.set({ status: 'available', latestVersion: info.version, notes: info.notes, releaseUrl: info.url, kind, total: file.size,
        message: kind === 'payload' ? t("有新版本。只下载程序代码，安装后重启生效。") : t("此版本升级了运行环境，需要下载安装器。") });
    } catch (error) { return this.set({ status: controller.signal.aborted ? 'idle' : 'error', message: controller.signal.aborted ? t("已取消检查。") : error.message }); }
    finally { this.controller = null; }
  }
  async download() {
    this.busy(); if (!this.candidate) throw new Error(t("请先检查更新。"));
    const candidate = this.candidate, { manifest, envelope, kind } = candidate;
    const controller = this.controller = new AbortController(); const file = manifest[kind];
    const temporary = path.join(this.runtime.root, `${crypto.randomUUID()}.download`), unpacked = `${temporary}.unpacked`;
    this.set({ status: 'downloading', downloaded: 0, message: t("正在下载并校验更新…") });
    try {
      const token = candidate.authenticated ? await this.token() : null;
      await candidate.network.download(candidate.download, file, temporary, token, controller.signal, (downloaded, total) => this.set({ downloaded, total }));
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

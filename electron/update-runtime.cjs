'use strict';
const { t } = require('./i18n.mjs');

// Electron's patched fs treats .asar files as directories; verify their raw bytes.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPattern, verifyManifest, compatible, newer, BOOTSTRAP_VERSION } = require('./update-policy.cjs');

function regular(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error(t("更新缓存文件无效。"));
  return stat;
}
function hashFile(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { let length; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function atomicJson(file, value) {
  if (fs.existsSync(file)) regular(file, 65536);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function directory(folder) {
  fs.mkdirSync(folder, { recursive: true });
  if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw new Error(t("更新缓存目录不能是链接。"));
}

class UpdateRuntime {
  constructor({ userData, baseVersion, electron, platform, arch, key, nativeIcon = null, bootstrap = BOOTSTRAP_VERSION }) {
    Object.assign(this, { baseVersion, electron, platform, arch, key, nativeIcon, bootstrap });
    this.version = baseVersion; this.current = null; this.message = '';
    this.root = path.join(userData, 'updates-v1'); directory(this.root);
    this.payloads = path.join(this.root, 'payloads'); directory(this.payloads);
    this.stateFile = path.join(this.root, 'active.json');
  }
  readState() {
    if (!fs.existsSync(this.stateFile)) return { current: null, previous: null, attempt: false };
    regular(this.stateFile, 65536);
    const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    if (![state.current, state.previous].every(value => value === null || typeof value === 'string' && hashPattern.test(value)) || typeof state.attempt !== 'boolean') throw new Error(t("更新启动记录无效。"));
    return state;
  }
  paths(id) {
    if (!hashPattern.test(id)) throw new Error(t("更新缓存标识无效。"));
    directory(this.root); directory(this.payloads);
    return { archive: path.join(this.payloads, `${id}.asar`), manifest: path.join(this.payloads, `${id}.json`) };
  }
  validate(id) {
    const files = this.paths(id); regular(files.manifest, 65536);
    const manifest = verifyManifest(JSON.parse(fs.readFileSync(files.manifest, 'utf8')), this.key, { platform: this.platform });
    if (manifest.asarSha256 !== id || !compatible(manifest, this)) throw new Error(t("此轻量更新需要更新运行环境或应用图标，请使用完整安装器。"));
    if (regular(files.archive, manifest.asarSize).size !== manifest.asarSize || hashFile(files.archive) !== id) throw new Error(t("程序更新校验失败。"));
    return { manifest, archive: files.archive };
  }
  selectStartup() {
    this.acknowledged = false;
    let state;
    try { state = this.readState(); }
    catch { this.message = t("更新记录损坏，已使用安装时的版本。"); return null; }
    const candidates = state.attempt ? [state.previous] : [state.current, state.previous];
    if (state.attempt) this.message = t("新版本上次启动未完成，已回退到可用版本。");
    for (const id of candidates) {
      if (!id) continue;
      try {
        const selected = this.validate(id);
        if (!newer(selected.manifest.version, this.baseVersion)) break;
        this.current = id; this.version = selected.manifest.version;
        atomicJson(this.stateFile, { current: id, previous: id === state.current ? state.previous : null, attempt: true });
        return selected.archive;
      } catch { this.message = t("程序更新未通过启动校验，已回退到可用版本。"); }
    }
    // A newer full installation supersedes the previous code-only update.
    if (state.current) atomicJson(this.stateFile, { current: null, previous: null, attempt: false });
    return null;
  }
  healthy() {
    if (this.acknowledged) return;
    const state = this.readState();
    if (state.current !== this.current) return;
    if (this.current) atomicJson(this.stateFile, { ...state, attempt: false });
    this.acknowledged = true;
    // Keep the running version and its rollback candidate; remove only our own files.
    directory(this.root); directory(this.payloads);
    const keep = new Set([state.current, state.previous]);
    for (const name of fs.readdirSync(this.payloads)) {
      const match = /^([a-f0-9]{64})\.(asar|json)$/.exec(name);
      if (!match || keep.has(match[1])) continue;
      const file = path.join(this.payloads, name), stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file);
    }
  }
  activate(id) {
    const selected = this.validate(id);
    if (!newer(selected.manifest.version, this.version)) throw new Error(t("不能安装相同或更早的版本。"));
    atomicJson(this.stateFile, { current: id, previous: this.current, attempt: false });
  }
}
module.exports = { UpdateRuntime, hashFile, atomicJson, regular, directory };

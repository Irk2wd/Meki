'use strict';
const { t } = require('./i18n.mjs');

const crypto = require('node:crypto');
const { APP_ID, REPOSITORY, UPDATE_PREFIX, installerName } = require('./app-identity.cjs');
const BOOTSTRAP_VERSION = 2;
const MAX_PAYLOAD = 512 * 1024 * 1024;
const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) throw new Error(t("更新版本号无效。"));
  return value.split('.').map(Number);
}
function newer(left, right) {
  const a = version(left), b = version(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function names(value, platform) {
  version(value);
  if (!['win32', 'darwin'].includes(platform)) throw new Error(t("当前平台不支持应用内更新。"));
  const target = platform === 'win32' ? 'windows' : 'macos';
  return { manifest: `${UPDATE_PREFIX}-update-${target}.json`, payload: `${UPDATE_PREFIX}-${value}-${target}-app.asar.gz`,
    installer: installerName(value, platform) };
}
function fileInfo(value, name, maximum) {
  if (!value || value.name !== name || !hashPattern.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximum) throw new Error(t("更新文件信息无效。"));
}
function verifyManifest(envelope, key, expected = {}) {
  if (!envelope || envelope.schema !== 1 || typeof envelope.body !== 'string' || envelope.body.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.body) || typeof envelope.signature !== 'string') throw new Error(t("更新清单无效。"));
  const body = Buffer.from(envelope.body, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || !crypto.verify(null, body, key, signature)) throw new Error(t("更新签名校验失败，已拒绝此更新。"));
  let manifest;
  try { manifest = JSON.parse(body.toString('utf8')); } catch { throw new Error(t("更新清单无效。")); }
  const files = names(manifest.version, manifest.platform);
  version(manifest.electron);
  if (manifest.appId !== APP_ID || !Number.isSafeInteger(manifest.bootstrap) || manifest.bootstrap < 1 || manifest.bootstrap > 100 ||
    manifest.arch !== (manifest.platform === 'win32' ? 'x64' : 'universal') ||
    expected.version && manifest.version !== expected.version || expected.platform && manifest.platform !== expected.platform) throw new Error(t("更新清单与应用版本或平台不符。"));
  fileInfo(manifest.payload, files.payload, MAX_PAYLOAD);
  fileInfo(manifest.installer, files.installer, MAX_DOWNLOAD);
  if (!hashPattern.test(manifest.asarSha256) || !Number.isSafeInteger(manifest.asarSize) || manifest.asarSize < 1 || manifest.asarSize > MAX_PAYLOAD) throw new Error(t("程序更新大小无效。"));
  return manifest;
}
function compatible(manifest, { electron, arch, bootstrap = BOOTSTRAP_VERSION }) {
  return manifest.bootstrap <= bootstrap && manifest.electron === electron &&
    (manifest.platform === 'darwin' ? ['x64', 'arm64'].includes(arch) : arch === 'x64');
}
function releaseInfo(release, repository = REPOSITORY) {
  if (repository !== REPOSITORY) throw new Error(t("更新仓库无效。"));
  if (!release || release.draft || release.prerelease || !release.published_at || !Array.isArray(release.assets) || release.assets.length > 100) throw new Error(t("未找到可用的正式更新。"));
  const value = String(release.tag_name || '').replace(/^v/, ''); version(value);
  return { version: value, notes: String(release.body || '').slice(0, 16000), url: `https://github.com/${repository}/releases/tag/v${value}` };
}
function asset(release, name) {
  const matches = release.assets.filter(item => item.name === name && item.state === 'uploaded');
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0 || !Number.isSafeInteger(matches[0].size) || matches[0].size <= 0) throw new Error(t("此版本缺少应用内更新文件，请等待发布者补齐。"));
  return matches[0];
}
module.exports = { REPOSITORY, BOOTSTRAP_VERSION, MAX_PAYLOAD, MAX_DOWNLOAD, digest, hashPattern, version, newer, names, verifyManifest, compatible, releaseInfo, asset };

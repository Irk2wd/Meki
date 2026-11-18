'use strict';
const { t } = require('./i18n.mjs');

const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { UPDATE_PREFIX } = require('./app-identity.cjs');
const { REPOSITORY, asset, digest, names, newer, releaseInfo } = require('./update-policy.cjs');
const crypto = require('node:crypto');

class GithubUpdates {
  constructor({ testOrigin, repository = REPOSITORY } = {}) {
    if (repository !== REPOSITORY) throw new Error('Invalid update repository');
    this.origin = testOrigin || 'https://api.github.com';
    if (testOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(testOrigin)) throw new Error('Invalid update test origin');
    this.test = Boolean(testOrigin);
    this.repository = repository;
  }
  async response(resource, signal, binary) {
    let url = new URL(`${this.origin}/repos/${this.repository}/${resource}`);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(binary ? 600000 : 45000)]);
    for (let redirects = 0; redirects < 5; redirects++) {
      let response;
      try { response = await fetch(url, { signal: combined, redirect: 'manual', headers: {
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': `${UPDATE_PREFIX}-updates`, 'Cache-Control': 'no-cache',
      } }); } catch { if (signal.aborted) throw new Error(t("更新已取消。")); throw new Error(t("无法连接更新服务，请检查网络后重试。")); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        const next = new URL(location || '', url);
        const allowed = this.test ? next.origin === this.origin : next.protocol === 'https:' &&
          ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(next.hostname) && !next.port;
        if (!location || !allowed || next.username || next.password) throw new Error(t("更新下载地址校验失败。"));
        url = next; continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && !binary) throw Object.assign(new Error(t("尚无适用于当前平台的完整正式更新。")), { code: 'NO_RELEASE' });
        if (response.status === 403) throw new Error(t("GitHub 更新请求受限，请稍后重试。"));
        throw new Error(t("更新服务暂时不可用（{0}）。", response.status));
      }
      if (!response.body) throw new Error(t("更新服务返回了空文件。"));
      return response;
    }
    throw new Error(t("更新下载重定向过多。"));
  }
  async bytes(resource, signal, limit, binary = false) {
    const response = await this.response(resource, signal, binary), parts = []; let size = 0;
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error(t("更新清单过大。")); }
    for await (const part of response.body) {
      size += part.length; if (size > limit) throw new Error(t("更新清单过大。")); parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  }
  async latest(signal, platform) {
    const pageSize = 20;
    let latestRelease, latestVersion;
    // The repository's featured release and creation order can both differ from the mekiR version order.
    for (let page = 1; ; page++) {
      const bytes = await this.bytes(`releases?per_page=${pageSize}&page=${page}`, signal, 2 * 1024 * 1024);
      let releases;
      try { releases = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error(t("更新服务返回了无效清单。")); }
      if (!Array.isArray(releases) || releases.length > pageSize) throw new Error(t("更新服务返回了无效清单。"));
      for (const release of releases) {
        let info;
        try {
          info = releaseInfo(release, this.repository);
          for (const name of Object.values(names(info.version, platform))) asset(release, name);
        } catch { continue; }
        if (!latestVersion || newer(info.version, latestVersion)) {
          latestRelease = release;
          latestVersion = info.version;
        }
      }
      if (releases.length < pageSize) break;
    }
    if (!latestRelease) throw Object.assign(new Error(t("尚无适用于当前平台的完整正式更新。")), { code: 'NO_RELEASE' });
    return latestRelease;
  }
  async manifest(asset, signal) {
    const bytes = await this.bytes(`releases/assets/${asset.id}`, signal, 65536, true);
    if (asset.digest && asset.digest !== `sha256:${digest(bytes)}`) throw new Error(t("更新清单传输校验失败。"));
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(t("更新清单无效。")); }
  }
  async download(asset, expected, file, signal, progress) {
    const response = await this.response(`releases/assets/${asset.id}`, signal, true);
    const length = response.headers.get('content-length');
    if (length && Number(length) !== expected.size) { await response.body.cancel(); throw new Error(t("更新文件大小不符。")); }
    const hash = crypto.createHash('sha256'); let size = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > expected.size) return done(new Error(t("更新文件超出预期大小。")));
      hash.update(chunk); progress(size, expected.size); done(null, chunk);
    } }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(t("更新文件校验失败，请重新下载。"));
  }
}
module.exports = { GithubUpdates };

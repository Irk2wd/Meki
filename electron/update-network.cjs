'use strict';
const { t } = require('./i18n.mjs');

const { REPOSITORY, digest, names, newer, releaseInfo, versionFromTag } = require('./update-policy.cjs');
const { readBytes, downloadFile } = require('./update-transfer.cjs');

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
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'Meki-updates', 'Cache-Control': 'no-cache',
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
    return readBytes(await this.response(resource, signal, binary), limit);
  }
  async releaseForTag(tag, signal) {
    versionFromTag(tag);
    const bytes = await this.bytes(`releases/tags/${tag}`, signal, 1024 * 1024);
    let release;
    try { release = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(t("更新服务返回了无效清单。")); }
    releaseInfo(release, this.repository);
    if (release.tag_name !== tag) throw new Error(t("更新服务返回了无效清单。"));
    return release;
  }
  async latest(signal, platform) {
    let latest;
    try { latest = JSON.parse((await this.bytes('releases/latest', signal, 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(t("更新服务返回了无效清单。")); throw error; }
    if (!platform || this.hasPlatformAssets(latest, platform)) return latest;
    // A Windows-only release must not break a Mac's update check.
    let releases;
    try { releases = JSON.parse((await this.bytes('releases?per_page=20', signal, 2 * 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(t("更新服务返回了无效清单。")); throw error; }
    if (!Array.isArray(releases) || releases.length > 100) throw new Error(t("更新服务返回了无效清单。"));
    const candidates = releases.filter(release => this.hasPlatformAssets(release, platform));
    candidates.sort((left, right) => newer(releaseInfo(left).version, releaseInfo(right).version) ? -1 : newer(releaseInfo(right).version, releaseInfo(left).version) ? 1 : 0);
    if (!candidates.length) throw Object.assign(new Error(t("尚无适用于当前平台的完整正式更新。")), { code: 'NO_RELEASE' });
    return candidates[0];
  }
  hasPlatformAssets(release, platform) {
    let info;
    try { info = releaseInfo(release, this.repository); } catch { return false; }
    const expected = Object.values(names(info.version, platform));
    return expected.every(name => release.assets.some(asset => asset.name === name && asset.state === 'uploaded'));
  }
  async manifest(asset, signal) {
    const bytes = await this.bytes(`releases/assets/${asset.id}`, signal, 65536, true);
    if (asset.digest && asset.digest !== `sha256:${digest(bytes)}`) throw new Error(t("更新清单传输校验失败。"));
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(t("更新清单无效。")); }
  }
  async download(asset, expected, file, signal, progress) {
    const response = await this.response(`releases/assets/${asset.id}`, signal, true);
    return downloadFile(response, expected, file, signal, progress);
  }
}
module.exports = { GithubUpdates };

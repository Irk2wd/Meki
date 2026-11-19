'use strict';
const { t } = require('./i18n.mjs');
const { readBytes, downloadFile } = require('./update-transfer.cjs');
const { PRODUCT_NAME } = require('./app-identity.cjs');

function mirrorUrl(value, test = false) {
  const url = new URL(value);
  const secure = url.protocol === 'https:';
  const loopback = test && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!secure && !loopback) || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTPS update mirror base URL.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

class MirrorUpdates {
  constructor({ url, testOrigin, idleTimeout = 12000 } = {}) {
    this.base = mirrorUrl(testOrigin || url, Boolean(testOrigin));
    this.idleTimeout = idleTimeout;
  }

  static configured() {
    const { updateMirror: url } = require('../package.json');
    try { return url ? new MirrorUpdates({ url }) : null; }
    catch { return null; }
  }

  async request(resource, signal, accept) {
    const response = await fetch(new URL(resource, this.base), { signal, redirect: 'error', headers: {
      Accept: accept, 'User-Agent': `${PRODUCT_NAME}-updates`, 'Cache-Control': 'no-cache',
    } });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(t("更新镜像暂不可用。"));
    }
    return response;
  }

  async latest(filename, signal) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const response = await this.request(`latest/${filename}`, timeout, 'application/json');
    const update = JSON.parse((await readBytes(response, 65536)).toString('utf8'));
    if (!update || typeof update.notes !== 'string') throw new Error(t("更新清单无效。"));
    const age = Date.now() / 1000 - update.checkedAt;
    if (!Number.isSafeInteger(update.checkedAt) || age < -300 || age > 60 * 60) throw new Error(t("更新镜像暂不可用。"));
    return update;
  }

  async download(tag, expected, file, signal, progress) {
    const attempt = new AbortController();
    const combined = AbortSignal.any([signal, attempt.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    let timer;
    const keepAlive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => attempt.abort(), this.idleTimeout);
    };
    try {
      keepAlive();
      const response = await this.request(`releases/${tag}/${expected.name}`, combined, 'application/octet-stream');
      keepAlive();
      await downloadFile(response, expected, file, combined, (received, total) => {
        keepAlive();
        progress(received, total);
      });
    } finally { clearTimeout(timer); }
  }
}

module.exports = { MirrorUpdates, mirrorUrl };

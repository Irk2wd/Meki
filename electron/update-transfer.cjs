'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { t } = require('./i18n.mjs');

async function readBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new Error(t("更新清单过大。"));
  }
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error(t("更新清单过大。"));
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

async function downloadFile(response, expected, file, signal, progress) {
  const length = response.headers.get('content-length');
  if (length && Number(length) !== expected.size) {
    await response.body.cancel();
    throw new Error(t("更新文件大小不符。"));
  }
  const hash = crypto.createHash('sha256');
  let size = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > expected.size) return done(new Error(t("更新文件超出预期大小。")));
    hash.update(chunk);
    progress(size, expected.size);
    done(null, chunk);
  } }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(t("更新文件校验失败，请重新下载。"));
}

module.exports = { readBytes, downloadFile };

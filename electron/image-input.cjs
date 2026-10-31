'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_IMAGE_COUNT = 32;
const MAX_BATCH_BYTES = 80 * 1024 * 1024;
const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];
async function readSelectedImages(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_IMAGE_COUNT) throw new Error(t("一次可添加 1–32 张图片。"));
  let total = 0;
  const inputs = [];
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') || !imageExtensions.includes(path.extname(filePath).slice(1).toLowerCase())) throw new Error(t("请选择支持的图片文件。"));
    const file = await fs.open(filePath, 'r');
    try {
      const info = await file.stat(); total += info.size;
      if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 * 1024 || total > MAX_BATCH_BYTES) throw new Error(t("每张图片不超过 20 MiB，每批不超过 80 MiB。"));
      // Keep the read bounded even if another process grows the file after stat.
      const buffer = Buffer.alloc(info.size + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
      const after = await file.stat();
      if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error(t("图片正在被修改，请重试。"));
      inputs.push({ name: path.basename(filePath), bytes: buffer.subarray(0, length) });
    } finally { await file.close(); }
  }
  return inputs;
}
module.exports = { readSelectedImages, imageExtensions, MAX_IMAGE_COUNT, MAX_BATCH_BYTES };

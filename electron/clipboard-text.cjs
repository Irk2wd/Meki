'use strict';
const { t } = require('./i18n.mjs');

const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
function validateClipboardText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES || text.includes('\0')) throw new TypeError(t("剪贴板文本不能超过 16 MiB 或含有 NUL 字符。"));
  return text;
}
function registerClipboardText(register, clipboard) {
  register('read-clipboard-text', async () => {
    const text = validateClipboardText(await clipboard.readText());
    if (process.env.MEKI_TEST === '1') { const delay = Math.min(1000, Math.max(0, Number(process.env.MEKI_TEST_CLIPBOARD_DELAY) || 0)); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); }
    return text;
  });
  register('write-clipboard-text', text => clipboard.writeText(validateClipboardText(text)));
}
module.exports = { validateClipboardText, registerClipboardText, MAX_CLIPBOARD_BYTES };

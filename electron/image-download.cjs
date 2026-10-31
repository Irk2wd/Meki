'use strict';
const { t } = require('./i18n.mjs');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 20 * 1024 * 1024;
const blocks = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocks.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocks.addSubnet(address, prefix, 'ipv6');
function isPublicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !blocks.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocks.check(address, 'ipv6');
}
function imageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || value !== value.trim() || /[\x00-\x20\\]/.test(value)) throw new Error(t("图片地址无效。"));
  let url; try { url = new URL(value); } catch { throw new Error(t("图片地址无效。")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error(t("只能下载不含账号密码的 HTTP(S) 图片地址。"));
  url.hash = ''; return url;
}
const types = [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'], ['.svg', 'image/svg+xml']];
function signature(bytes, extension) {
  if (!bytes.length) return false;
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === '.gif') return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'));
  if (extension === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === '.avif') return bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 40).toString('ascii'));
  if (extension === '.bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (extension === '.ico') return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
  if (extension === '.svg') {
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text) || !/<\/svg\s*>\s*$/i.test(text)) return false;
    // XML resolves character references before CSS sees them. Check that representation too;
    // CSS escapes and prefixed element names are deliberately outside this static subset.
    text = text.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_match, hex, decimal) => {
      const value = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return value <= 0x10ffff ? String.fromCodePoint(value) : '\ufffd';
    });
    return !text.includes('\\') && !/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<\s*\/?\s*[^\s/>]*:|<\s*(?:script|foreignObject|iframe|object|embed|image|feImage|use|animate|animateMotion|animateTransform|set|discard)\b|\bon\w+\s*=|\b(?:href|src)\s*=|(?:url|expression)\s*\(|@import|javascript:/i.test(text);
  }
  return false;
}
function sniffImage(bytes, validateImage) {
  for (const [extension, mime] of types) if (signature(bytes, extension) && (!validateImage || validateImage(bytes, extension))) return { extension, mime };
  throw new Error(t("下载内容不是支持的图片，或 SVG 包含外部资源／活动内容。"));
}
function downloadName(url, extension) {
  let pathname = url.pathname; try { pathname = decodeURIComponent(pathname); } catch { /* A generated name is sufficient for malformed escapes. */ }
  let stem = path.posix.basename(pathname.replace(/\\/g, '/'));
  stem = path.posix.parse(stem).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'image';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = `image-${stem}`;
  return stem + extension;
}
function requestImage(url, address, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, autoSelectFamily: false, family: address.family, signal,
      headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, resolve);
    request.on('error', reject); request.end();
  });
}
function createImageDownloader({ lookup = (host) => dns.lookup(host, { all: true, verbatim: true }), allowedAddress = isPublicAddress } = {}) {
  return async function downloadImage(source, options = {}) {
    const { signal, validateImage, onProgress } = options;
    const maxBytes = options.maxBytes ?? MAX_BYTES, timeoutMs = options.timeoutMs ?? 30000, maxRedirects = options.maxRedirects ?? 3;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new Error(t("无效的图片下载限制。"));
    if (signal?.aborted) throw new Error(t("图片下载已取消。"));
    let url = imageUrl(source), timedOut = false;
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); timeout.unref?.();
    try {
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = net.isIP(hostname);
        const addresses = family ? [{ address: hostname, family }] : await Promise.race([
          lookup(hostname), new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(t("下载已取消。"))), { once: true })),
        ]);
        controller.signal.throwIfAborted();
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || !allowedAddress(item.address) || net.isIP(item.address) !== item.family)) throw new Error(t("图片地址指向本机、内网或不可下载的网络地址。"));
        const response = await requestImage(url, addresses[0], controller.signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            if (redirects >= maxRedirects || !response.headers.location) throw new Error(t("图片下载重定向过多或缺少目标地址。"));
            const next = imageUrl(new URL(response.headers.location, url).href);
            if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error(t("图片下载拒绝从 HTTPS 跳转到不安全的 HTTP。"));
            url = next; continue;
          }
          if (response.statusCode !== 200) throw new Error(t("图片下载失败（HTTP {0}）。", response.statusCode));
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error(t("图片超过允许的下载大小。"));
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error(t("图片服务器返回了不受支持的内容编码。"));
          const chunks = []; let received = 0;
          for await (const chunk of response) {
            received += chunk.length;
            if (received > maxBytes) throw new Error(t("图片超过允许的下载大小。"));
            chunks.push(chunk); onProgress?.(received, length === undefined ? null : Number(length));
          }
          controller.signal.throwIfAborted();
          const bytes = Buffer.concat(chunks, received), image = sniffImage(bytes, validateImage);
          return { bytes, name: downloadName(url, image.extension), ...image, finalUrl: url.href };
        } finally { response.destroy(); }
      }
    } catch (error) {
      if (timedOut) throw new Error(t("图片下载超时，请重试。"));
      if (signal?.aborted) throw new Error(t("图片下载已取消。"));
      throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  };
}
const downloadImage = createImageDownloader();
module.exports = { MAX_BYTES, imageUrl, isPublicAddress, sniffImage, createImageDownloader, downloadImage };

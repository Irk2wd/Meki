'use strict';

const dns = require('node:dns/promises');
const {BlockList, isIP} = require('node:net');
const {t} = require('./i18n.mjs');

const overlay = new BlockList();
overlay.addSubnet('100.64.0.0', 10, 'ipv4');
overlay.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
const magicName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/;

async function matchingTailnetUrl(base, ip, family) {
  const {hostname} = await dns.lookupService(ip, Number(base.port) || 443);
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (name.length > 253 || !magicName.test(name)) return;
  const addresses = await dns.lookup(name, {all:true, family});
  const original = new BlockList();
  const type = family === 4 ? 'ipv4' : 'ipv6';
  original.addAddress(ip, type);
  if (!addresses.some(({address}) => original.check(address, type))) return;
  const suggestion = new URL(base);
  suggestion.hostname = name;
  return suggestion.href;
}

async function connectionMessage(error, base) {
  const ip = base.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  const code = error.cause?.code || error.code || '';
  const tls = /^(?:ERR_(?:SSL|TLS)_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER))/.test(code);
  const tailnetIp = family && overlay.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  if (tailnetIp && base.protocol === 'https:' && (tls || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')) {
    // System DNS can be slow while disconnected. A name is advice for the user, never a credential redirect.
    let timer;
    let suggestion;
    try {
      suggestion = await Promise.race([
        matchingTailnetUrl(base, ip, family).catch(() => undefined),
        new Promise(resolve => { timer = setTimeout(resolve, 1500); timer.unref(); }),
      ]);
    } finally { clearTimeout(timer); }
    if (suggestion) return t("与 {0} 的 HTTPS 连接失败。请改用此设备的域名地址 {1} 重新连接。", base.host, suggestion);
    return t("与 {0} 的 HTTPS 连接失败。通过 Tailscale 连接时，请使用管理后台提供的完整订阅域名和端口。", base.host);
  }
  if (tls) return t("与 {0} 的 HTTPS 握手失败。请核对域名、端口和服务器证书。", base.host);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return base.hostname.endsWith('.ts.net')
      ? t("无法解析 {0}。请确认这台电脑已接入同一 Tailscale 网络，并可解析此域名。", base.hostname)
      : t("无法解析服务器域名 {0}。请检查地址和 DNS 设置。", base.hostname);
  }
  if (error.name === 'TimeoutError' || ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return t("连接 {0} 超时。请检查网络和服务器端口。", base.host);
  }
  return t("无法连接 {0}。请检查服务器地址、端口和网络连接。", base.host);
}

module.exports = {connectionMessage};

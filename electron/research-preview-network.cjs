'use strict';

const childProcess = require('node:child_process');
const dns = require('node:dns/promises');
const https = require('node:https');
const {BlockList, isIP} = require('node:net');
const path = require('node:path');
const {Readable} = require('node:stream');
const tls = require('node:tls');
const {t} = require('./i18n.mjs');

const overlay = new BlockList();
overlay.addSubnet('100.64.0.0', 10, 'ipv4');
overlay.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
const magicName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/;

const tlsError = /^(?:ERR_(?:SSL|TLS)_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER))/;

function tailnetIP(url) {
  const ip = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (url.protocol === 'https:' && family && overlay.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return ip;
}

function deviceName(value) {
  if (typeof value !== 'string') return;
  const name = value.toLowerCase().replace(/\.$/, '');
  if (name.length <= 253 && magicName.test(name)) return name;
}

function sameIP(ip, address) {
  const family = isIP(ip);
  if (isIP(address) !== family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const target = new BlockList();
  target.addAddress(ip, type);
  return target.check(address, type);
}

function peerName(ip, node) {
  const name = deviceName(node?.Name);
  if (!name || !Array.isArray(node.Addresses)) return;
  // A subnet route advertised by a peer does not identify the endpoint itself.
  const suffix = isIP(ip) === 4 ? '/32' : '/128';
  if (node.Addresses.some(cidr => {
    if (typeof cidr !== 'string' || !cidr.endsWith(suffix)) return false;
    const address = cidr.slice(0, -suffix.length);
    return sameIP(ip, address);
  })) return name;
}

function tailscaleClients() {
  if (process.platform === 'win32') return [path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  if (process.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
}

async function resolvePeer(base, ip, signal) {
  // Probe without HTTP credentials. A server with a valid IP certificate uses ordinary HTTPS.
  try {
    await new Promise((resolve, reject) => {
      const socket = tls.connect({host:ip, port:Number(base.port) || 443, rejectUnauthorized:true, signal}, () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });
    return;
  } catch (error) {
    if (!tlsError.test(error.code) && error.code !== 'ECONNRESET') throw error;
  }

  for (const file of tailscaleClients()) {
    signal.throwIfAborted();
    try {
      const payload = await new Promise((resolve, reject) => {
        childProcess.execFile(file, ['whois', '--json', ip], {timeout:4000, maxBuffer:1024*1024, windowsHide:true, signal},
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const name = peerName(ip, JSON.parse(payload).Node);
      if (name) return name;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') break;
    }
  }
  signal.throwIfAborted();
  throw Object.assign(new Error('No verified Tailscale peer'), {code:'ERR_MEKIR_TAILSCALE_PEER'});
}

function peerRequest(url, name, {method, headers, signal, body}) {
  // Dial the literal input address. Only the TLS server name and HTTP authority use the verified node name.
  const authority = url.port ? name + ':' + url.port : name;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {method, headers:{...headers, Host:authority}, servername:name, rejectUnauthorized:true, signal}, res => {
      try {
        const status = res.statusCode;
        const noBody = method === 'HEAD' || [204, 205, 304].includes(status);
        if (noBody) res.resume();
        const fields = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) fields.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(noBody ? null : Readable.toWeb(res), {status, headers:fields}));
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function suggestedURL(base) {
  const ip = tailnetIP(base);
  const {hostname} = await dns.lookupService(ip, Number(base.port) || 443);
  const name = deviceName(hostname);
  if (!name) return;
  const addresses = await dns.lookup(name, {all:true, family:isIP(ip)});
  if (!addresses.some(({address}) => sameIP(ip, address))) return;
  const url = new URL(base);
  url.hostname = name;
  return url.href;
}

async function connectionMessage(error, base) {
  const code = error.cause?.code || error.code || '';
  if (code === 'ERR_MEKIR_TAILSCALE_PEER') {
    // A DNS match is a hint for manual entry only. It never supplies the TLS identity above.
    let timer;
    try {
      const suggestion = await Promise.race([suggestedURL(base).catch(() => undefined),
        new Promise(resolve => { timer = setTimeout(resolve, 1500); timer.unref(); })]);
      if (suggestion) return t("与 {0} 的 HTTPS 连接失败。请改用此设备的域名地址 {1} 重新连接。", base.host, suggestion);
    } finally { clearTimeout(timer); }
    return t("无法确认 {0} 对应的 Tailscale 设备。请检查本机 Tailscale 的连接，或填写管理后台的订阅域名和端口。", base.host);
  }
  if (tlsError.test(code)) return t("与 {0} 的 HTTPS 握手失败。请核对域名、端口和服务器证书。", base.host);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return base.hostname.endsWith('.ts.net')
      ? t("无法解析 {0}。请确认这台电脑已接入同一 Tailscale 网络，并可解析此域名。", base.hostname)
      : t("无法解析服务器域名 {0}。请检查地址和 DNS 设置。", base.hostname);
  }
  if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError' || ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return t("连接 {0} 超时。请检查网络和服务器端口。", base.host);
  }
  return t("无法连接 {0}。请检查服务器地址、端口和网络连接。", base.host);
}

module.exports = {tailnetIP, resolvePeer, peerRequest, connectionMessage};

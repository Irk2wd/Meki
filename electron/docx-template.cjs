'use strict';
const { t } = require('./i18n.mjs');
const { inflateRawSync, crc32 } = require('node:zlib');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const LIMITS = Object.freeze({ archiveBytes: 16 * 1024 * 1024, entryBytes: 8 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024, entries: 256 });
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function invalid(message) { throw new Error(t("Word 样式模板不可用：{0}", message)); }
function extraFields(bytes) {
  for (let at = 0; at < bytes.length;) {
    if (at + 4 > bytes.length) invalid(t("ZIP 附加数据损坏。"));
    const type = bytes.readUInt16LE(at), size = bytes.readUInt16LE(at + 2); at += 4;
    if (type === 1 || at + size > bytes.length) invalid(t("不支持 ZIP64 或损坏的 ZIP 数据。"));
    at += size;
  }
}
function zipEntries(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > LIMITS.archiveBytes) invalid(t("文件需为不超过 16 MiB 的 DOCX。"));
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 4096); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid(t("不是受支持的单卷 ZIP 文件。"));
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (!count || count > LIMITS.entries || count !== bytes.readUInt16LE(end + 8) || centralStart + centralSize !== end) invalid(t("ZIP 条目数或目录范围不正确。"));
  const entries = new Map(), folded = new Set(), ranges = []; let at = centralStart, expanded = 0;
  for (let item = 0; item < count; item++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) invalid(t("ZIP 目录损坏。"));
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), checksum = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32);
    const external = bytes.readUInt32LE(at + 38), local = bytes.readUInt32LE(at + 42), next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || bytes.readUInt16LE(at + 34) || (flags & ~0x80e) || ![0, 8].includes(method) || size > LIMITS.entryBytes || compressed > LIMITS.archiveBytes || local >= centralStart) invalid(t("ZIP 包含加密、特殊或过大的条目。"));
    const unixType = (external >>> 16) & 0xf000;
    if (unixType && ![0x8000, 0x4000].includes(unixType)) invalid(t("模板不能包含链接或特殊文件。"));
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength), name = text(nameBytes);
    if (!name || name.length > 240 || /[\\:\x00-\x20\x7f%]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..') || folded.has(name.toLowerCase())) invalid(t("ZIP 文件名无效或重复。"));
    folded.add(name.toLowerCase()); extraFields(bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid(t("ZIP 本地记录不匹配。"));
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), payload = local + 30 + localNameLength + localExtraLength;
    if (payload + compressed > centralStart || localNameLength !== nameLength || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) invalid(t("ZIP 内容范围不正确。"));
    extraFields(bytes.subarray(local + 30 + localNameLength, payload));
    let finish = payload + compressed;
    if (flags & 8) {
      if (finish + 12 > centralStart) invalid(t("ZIP 描述记录缺失。"));
      if (bytes.readUInt32LE(finish) === 0x08074b50) finish += 4;
      if (finish + 12 > centralStart || bytes.readUInt32LE(finish) !== checksum || bytes.readUInt32LE(finish + 4) !== compressed || bytes.readUInt32LE(finish + 8) !== size) invalid(t("ZIP 描述记录不匹配。"));
      finish += 12;
    } else if (bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size) invalid(t("ZIP 大小或摘要不匹配。"));
    expanded += size; if (expanded > LIMITS.expandedBytes) invalid(t("解压内容超过 32 MiB。"));
    let decoded;
    try { const value = bytes.subarray(payload, payload + compressed); decoded = method ? inflateRawSync(value, { maxOutputLength: Math.max(1, size) }) : value; }
    catch { invalid(t("ZIP 压缩内容损坏或超过声明大小。")); }
    if (decoded.length !== size || crc32(decoded) !== checksum) invalid(t("ZIP 内容校验失败。"));
    if (name.endsWith('/') && size) invalid(t("目录不能包含文件内容。"));
    entries.set(name, decoded); ranges.push([local, finish]); at = next;
  }
  if (at !== end) invalid(t("ZIP 目录长度不匹配。"));
  ranges.sort((a, b) => a[0] - b[0]); let finish = 0;
  for (const range of ranges) { if (range[0] !== finish) invalid(t("ZIP 记录重叠或包含额外内容。")); finish = range[1]; }
  if (finish !== centralStart) invalid(t("ZIP 存在未声明内容。"));
  return entries;
}
function entities(value) {
  const result = value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, entity) => {
    if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) invalid(t("XML 字符不正确。"));
    return String.fromCodePoint(code);
  });
  if (/&(?:#|[A-Za-z])[^\s<;]*;/.test(result)) invalid(t("不支持 XML 自定义实体。"));
  return result;
}
function attributes(source) {
  const result = {}; let remaining = source.trim();
  while (remaining) {
    const match = remaining.match(/^([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2\s*/);
    if (!match || Object.hasOwn(result, match[1])) invalid(t("XML 属性不正确。"));
    result[match[1]] = entities(match[3]); remaining = remaining.slice(match[0].length);
  }
  return result;
}
function validateDocx(bytes) {
  const entries = zipEntries(bytes);
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) if (!entries.has(required)) invalid(t("缺少 {0}。", required));
  if (!text(entries.get('[Content_Types].xml')).includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) invalid(t("不是普通 Word DOCX 文档。"));
  for (const [name, value] of entries) {
    if (name.endsWith('/')) continue;
    if (!(name === '[Content_Types].xml' || name === '_rels/.rels' || /^(?:word|docProps)\/.+\.(?:xml|rels)$/.test(name) || /^word\/media\/[\w.-]+\.(?:png|jpe?g|gif)$/.test(name))) invalid(t("不支持模板部件 {0}。请使用只修改样式的 DOCX 模板。", name));
    if (!/\.(?:xml|rels)$/.test(name)) continue;
    let xml = text(value).replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
    if (/<!|<\?|\x00/.test(xml)) invalid(t("不支持 XML 实体、处理指令或嵌入内容。"));
    const decoded = entities(xml);
    if (/macroEnabled|vbaProject|activeX|oleObject|attachedTemplate|altChunk|afChunk|\b(?:DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE)\b/i.test(decoded)) invalid(t("模板含宏、嵌入对象或外部内容。"));
    if (name.endsWith('.rels')) {
      if (!/^\s*<(?:\w+:)?Relationships\b/.test(xml)) invalid(t("关系文件格式不正确。"));
      const relationships = [...xml.matchAll(/<(?:\w+:)?Relationship\s+([^<>]*?)\s*\/?\s*>/g)];
      const base = name === '_rels/.rels' ? '' : path.posix.dirname(name.replace('/_rels/', '/'));
      const ids = new Set();
      for (const match of relationships) {
        const attr = attributes(match[1]);
        if (!attr.Id || ids.has(attr.Id) || !attr.Type || !attr.Target || Object.keys(attr).some(key => !['Id', 'Type', 'Target', 'TargetMode'].includes(key))) invalid(t("关系记录不正确。"));
        ids.add(attr.Id);
        if (attr.TargetMode === 'External') {
          // A hyperlink is passive until the user clicks it; Pandoc does not fetch its destination.
          const hyperlink = /^(?:http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006|http:\/\/purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/hyperlink$/.test(attr.Type);
          let url; try { url = new URL(attr.Target); } catch { invalid(t("超链接地址无效。")); }
          if (!hyperlink || !['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20]/.test(attr.Target)) invalid(t("模板不能包含外部资源或带凭据的链接。"));
          continue;
        }
        if (attr.TargetMode && attr.TargetMode !== 'Internal') invalid(t("模板包含不支持的关系类型。"));
        let target;
        try { target = decodeURIComponent(attr.Target).split('#', 1)[0]; } catch { invalid(t("关系路径编码无效。")); }
        if (!target || /[\\:\x00-\x20]/.test(target) || target.startsWith('/')) invalid(t("模板不能引用外部路径。"));
        const resolved = path.posix.normalize(path.posix.join(base, target));
        if (resolved.startsWith('../') || !entries.has(resolved)) invalid(t("模板的内部资源缺失或越界。"));
      }
      // Reject malformed records instead of silently skipping them during security validation.
      const rest = xml.replace(/<\/?(?:\w+:)?Relationships\b[^<>]*>/g, '').replace(/<(?:\w+:)?Relationship\s+[^<>]*?\s*\/?\s*>/g, '').trim();
      if (rest) invalid(t("关系文件包含不支持的内容。"));
    }
  }
  return { entries: entries.size, expandedBytes: [...entries.values()].reduce((sum, value) => sum + value.length, 0) };
}
module.exports = { validateDocx, zipEntries, LIMITS };

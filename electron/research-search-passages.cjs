'use strict';

const { isDate } = require('./research-model.cjs');

const metricUnit = /(?:毫秒|微秒|秒|帧率|帧时间|耗时|时延|用时|计时|延迟|latency|timings?|\b(?:ms|fps|µs|us|seconds?)\b)/i;
const numberCell = /(?:^|[^\p{L}\d])[-+]?\d+(?:[.,]\d+)*(?:\s*%|\b)/u;
function tableStrength(rows, header) {
  return rows.filter(row => numberCell.test(row)).length >= 2 ? (metricUnit.test(header) ? 2 : 1) : 0;
}
function plain(s) {
  return s.replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__|~~|\x60+)(.+?)\1/g, '$2').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
}
function markdownPassages(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n'), passages = [], occurrences = new Map();
  let heading = '', fence = '', comment = false;
  function emit(text, line, anchor, extra = {}, strength = 0) {
    if (!text || !anchor) return;
    const signature = heading + '\n' + anchor.slice(0, 150);
    const occurrence = occurrences.get(signature) || 0;
    occurrences.set(signature, occurrence + 1);
    const locator = { kind: 'paragraph', line, heading, anchor: anchor.slice(0, 150), occurrence, ...extra };
    passages.push({ text, locator, strength });
  }
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (comment) { if (line.includes('-->')) comment = false; i++; continue; }
    if (line.startsWith('<!--')) { comment = !line.includes('-->'); i++; continue; }
    if (fence) { if (line.startsWith(fence)) fence = ''; i++; continue; }
    const code = /^(\x60{3,}|~{3,})/.exec(line);
    if (code) { fence = code[1]; i++; continue; }
    if (!line) { i++; continue; }
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (h) { heading = plain(h[1]); i++; continue; }
    const first = i++;
    if (line.includes('|') && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i] || '')) {
      const cells = value => value.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(plain);
      const cols = cells(line);
      const trialTable = /^(?:实验试次|trials)$/i.test(heading) && /^(?:试次\s*ID|trial ID)$/i.test(cols[0]) && /^(?:实验日期|date)$/i.test(cols[1]);
      i++;
      const start = i;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) i++;
      const rows = lines.slice(start, i).map(cells);
      const strength = tableStrength(rows.map(row => row.join(' ')), cols.join(' '));
      for (const [index, row] of rows.entries()) {
        if (!row.some(Boolean)) continue;
        const trial = trialTable && row[0] && isDate(row[1]) ? { kind: 'trial', trialId: row[0], date: row[1] } : {};
        const text = row.map((value, n) => (cols[n] ? cols[n] + ' ' : '') + value).join(' · ');
        emit(text, start + index + 1, row.join(' '), trial, strength);
      }
      continue;
    }
    while (i < lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|\||<!--|\x60{3}|~{3}|[-+*]\s|\d+\.\s)/.test(lines[i])) i++;
    const content = plain(lines.slice(first, i).join(' ').replace(/^(?:>\s*|[-+*]\s+|\d+\.\s+)/, ''));
    emit(content, first + 1, content);
  }
  return passages;
}

async function reportPassages(format, bytes) {
  const runtime = require('./research-search-runtime.cjs');
  if (format === 'pptx') {
    const ppt = await runtime.load('ppt');
    if (!globalThis.DOMParser) {
      const { DOMParser } = require(runtime.location('xml'));
      // The slide parser checks for the browser's parsererror element. xmldom throws on invalid XML.
      globalThis.DOMParser = class extends DOMParser {
        parseFromString(xml, mime) {
          const parsed = super.parseFromString(xml.trimStart(), mime);
          parsed.querySelector = name => parsed.getElementsByTagName(name)[0] || null;
          return parsed;
        }
      };
    }
    const zip = await ppt.parseZipLazyMedia(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ppt.RECOMMENDED_ZIP_LIMITS);
    const slides = ppt.buildPresentation(zip), grouped = Array.from({ length: slides.slides.length }, () => []);
    for (const entry of ppt.buildTextIndex(slides)) grouped[entry.slideIndex].push(entry);
    return grouped.map((entries, i) => {
      const text = entries.map(e => e.text).join(' ');
      const cells = entries.filter(e => e.textKind === 'table-cell' && e.rowIndex > 0).map(e => e.text);
      return { text, strength: tableStrength(cells, text), locator: { kind: 'page', page: i + 1 } };
    }).filter(p => p.text.trim());
  }
  const pdf = await runtime.load('pdf');
  const path = require('node:path'), fs = require('node:fs');
  const assets = path.join(__dirname, '../dist/pdf-data');
  const options = fs.existsSync(assets) ? { cMapUrl: path.join(assets, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: path.join(assets, 'standard_fonts') + '/' } : {};
  const doc = await pdf.getDocumentProxy(new Uint8Array(bytes), options);
  const passages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      const rows = new Map();
      for (const item of items) {
        if (!item.str?.trim()) continue;
        const y = Math.round(item.transform[5] / 3);
        const row = rows.get(y) || [];
        row.push(item.str.trim()); rows.set(y, row);
      }
      const text = [...rows.values()].map(row => row.join(' ')).join('\n');
      const numericRows = [...rows.values()].filter(row => row.length > 1 && row.some(cell => /^[-+]?\d+(?:[.,]\d+)*\s*(?:%|ms)?$/i.test(cell))).map(row => row.join(' '));
      if (text) passages.push({ text, strength: tableStrength(numericRows, text), locator: { kind: 'page', page: n } });
      page.cleanup();
    }
  } finally { await doc.loadingTask.destroy(); }
  return passages;
}
module.exports = { markdownPassages, reportPassages };

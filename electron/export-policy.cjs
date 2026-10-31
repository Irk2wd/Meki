'use strict';
const { t } = require('./i18n.mjs');
const KINDS = new Set(['html', 'plain-html', 'pdf', 'png', 'docx', 'epub']);
const MAX_HTML = 96 * 1024 * 1024;
const defaultPdf = { pageSize: 'A4', landscape: false, margin: 19, pageNumbers: false, header: false, pageBreakBeforeH1: false };
function validateExport(input) {
  if (!input || !KINDS.has(input.kind) || typeof input.suggestedName !== 'string' || input.suggestedName.length > 512 || typeof input.html !== 'string' || !input.html.trim() || Buffer.byteLength(input.html) > MAX_HTML) throw new TypeError(t("导出内容为空、过大或格式不正确。"));
  if (Object.keys(input).some(key => !['kind', 'suggestedName', 'html', 'pdf', 'pngWidth', 'pngScale', 'theme', 'fontSize', 'referenceId'].includes(key))) throw new TypeError(t("不支持的导出参数。"));
  const pdf = { ...defaultPdf, ...input.pdf };
  if (input.pdf !== undefined && (!input.pdf || typeof input.pdf !== 'object' || Array.isArray(input.pdf) || Object.keys(input.pdf).some(key => !Object.hasOwn(defaultPdf, key)))) throw new TypeError(t("PDF 设置不正确。"));
  if (!['A4', 'Letter', 'A5'].includes(pdf.pageSize) || typeof pdf.landscape !== 'boolean' || typeof pdf.pageNumbers !== 'boolean' || typeof pdf.header !== 'boolean' || typeof pdf.pageBreakBeforeH1 !== 'boolean' || !Number.isFinite(pdf.margin) || pdf.margin < 5 || pdf.margin > 40) throw new TypeError(t("PDF 页边距需为 5–40 毫米。"));
  if ((pdf.header || pdf.pageNumbers) && pdf.margin < 12) throw new TypeError(t("使用页眉或页码时，页边距至少为 12 毫米。"));
  const pngWidth = input.pngWidth ?? 960, pngScale = input.pngScale ?? 2;
  if (!Number.isInteger(pngWidth) || pngWidth < 640 || pngWidth > 1600 || ![1, 2].includes(pngScale)) throw new TypeError(t("图片宽度需为 640–1600 px，倍率为 1 或 2。"));
  const theme = input.theme ?? 'current', fontSize = input.fontSize ?? null, referenceId = input.referenceId ?? null;
  if (!['current', 'paper', 'linen', 'night'].includes(theme) || fontSize !== null && (!Number.isFinite(fontSize) || fontSize < 12 || fontSize > 32)) throw new TypeError(t("导出主题或字号不正确。"));
  if (referenceId !== null && (typeof referenceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(referenceId))) throw new TypeError(t("Word 模板 ID 不正确。"));
  return { ...input, pdf, pngWidth, pngScale, theme, fontSize, referenceId };
}
function validateRaster(width, height, scale = 1) {
  if (![width, height, scale].every(Number.isFinite) || width < 1 || height < 1 || width * scale > 8192 || height * scale > 20000 || width * height * scale * scale > 40_000_000) throw new Error(t("文稿图片过长或过大（最多 20,000 px 高、4,000 万像素）。请降低倍率、缩短文稿，或导出 PDF。"));
}
function validateDiagramSvg(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024 || !/^<svg\b/.test(value) || /<\?|<!|<(?:script|foreignObject|iframe|image|object|embed|audio|video)\b|\bon\w+\s*=|(?:href|src)\s*=\s*(?:["'](?!#)|[^\s"'])/i.test(value)) throw new Error(t("SVG 包含不支持的内容。"));
  for (const match of value.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>|\bstyle\s*=\s*(["'])([\s\S]*?)\2/gi)) {
    const css = (match[1] || match[3]).replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi, (_entity, hex, decimal, named) => hex || decimal ? String.fromCodePoint(Math.min(parseInt(hex || decimal, hex ? 16 : 10), 0x10ffff)) : ({ amp:'&', quot:'"', apos:"'", lt:'<', gt:'>' })[named.toLowerCase()]);
    if (/\\|@import|(?:image|image-set|cross-fade|paint|element|expression)\s*\(|url\s*\((?!\s*["']?#[\w:.-]+["']?\s*\))/i.test(css)) throw new Error(t("SVG 不可加载外部样式或资源。"));
  }
  return value;
}
const escape = value => value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
function pdfPrintOptions(pdf, title, textColor = '#555') {
  // Computed document color is reused in the isolated header/footer templates.
  const color = typeof textColor === 'string' && textColor.length < 128 && /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\([a-z\d.,% /+-]+\))$/i.test(textColor) ? textColor : '#555';
  return { printBackground: true, preferCSSPageSize: false, pageSize: pdf.pageSize, landscape: pdf.landscape,
    margins: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, pdf.margin / 25.4])),
    displayHeaderFooter: pdf.header || pdf.pageNumbers,
    headerTemplate: pdf.header ? `<div style="font-size:9px;width:100%;text-align:center;color:${color}">${escape(title)}</div>` : '<span></span>',
    footerTemplate: pdf.pageNumbers ? `<div style="font-size:9px;width:100%;text-align:center;color:${color}"><span class="pageNumber"></span> / <span class="totalPages"></span></div>` : '<span></span>',
  };
}
module.exports = { validateExport, validateRaster, validateDiagramSvg, pdfPrintOptions, defaultPdf, MAX_HTML };

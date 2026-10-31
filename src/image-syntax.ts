import { t } from '../electron/i18n.mjs';
export interface ImageAttributes { src: string; alt: string; title: string | null; width: number | null; height: number | null }
export interface ParsedImage extends ImageAttributes { srcStart: number; srcEnd: number; quote: '"' | "'" }
export const MAX_IMAGE_DIMENSION = 10000;
export const imageDimension = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION ? value : null;

/** Image sources use the existing asset bridge; this does not grant filesystem access. */
export function safeImageSource(src: string) {
  if (!src || src !== src.trim() || /[\u0000-\u001f\u007f<>]/.test(src) || /^(?:\/\/|\\\\)/.test(src)) return false;
  if (/^https?:\/\//i.test(src)) { try { return Boolean(new URL(src).hostname); } catch { return false; } }
  if (/^data:/i.test(src)) return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml);base64,[a-z0-9+/]+=*$/i.test(src);
  if (/^file:/i.test(src)) { try { return new URL(src).protocol === 'file:'; } catch { return false; } }
  if (/^[a-z]:[\\/]/i.test(src)) return true;
  let decoded = src; try { decoded = decodeURIComponent(src); } catch { /* Literal percent is a valid local filename. */ }
  return !/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !/[\u0000-\u001f\u007f<>]/.test(decoded);
}

function decodeAttribute(value: string): string | null {
  let valid = true;
  const decoded = value.replace(/&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, entity => {
    const names: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    const name = entity.slice(1, -1);
    if (Object.hasOwn(names, name)) return names[name];
    if (name.startsWith('#')) {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    }
    valid = false; return entity;
  });
  return valid && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded) ? decoded : null;
}
export const escapeImageAttribute = (value: string, quote = '"') => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');

/** Recognize one complete image tag, never a fragment of general HTML. */
export function parseImageTag(source: string): ParsedImage | null {
  const start = /^\s*<img(?=\s|\/?>)/i.exec(source); if (!start) return null;
  let offset = start[0].length, srcStart = -1, srcEnd = -1, srcQuote: '"' | "'" = '"';
  const attrs = new Map<string, string>();
  while (offset < source.length) {
    const whitespace = /^\s*/.exec(source.slice(offset))![0]; offset += whitespace.length;
    const end = /^\/?>\s*$/.exec(source.slice(offset)); if (end) { offset = source.length; break; }
    if (!whitespace) return null;
    const nameMatch = /^([a-z][a-z0-9-]*)\s*=\s*/i.exec(source.slice(offset)); if (!nameMatch) return null;
    const name = nameMatch[1].toLowerCase();
    if (!['src', 'alt', 'title', 'width', 'height'].includes(name) || attrs.has(name)) return null;
    offset += nameMatch[0].length;
    const quote = source[offset]; let value: string;
    if (quote === '"' || quote === "'") {
      const from = ++offset, to = source.indexOf(quote, from); if (to < 0) return null;
      const decoded = decodeAttribute(source.slice(from, to)); if (decoded === null) return null;
      value = decoded; offset = to + 1;
      if (name === 'src') { srcStart = from; srcEnd = to; srcQuote = quote; }
    } else {
      if (name !== 'width' && name !== 'height') return null;
      const number = /^\d+/.exec(source.slice(offset)); if (!number) return null;
      value = number[0]; offset += value.length;
    }
    attrs.set(name, value);
  }
  const src = attrs.get('src'); if (srcStart < 0 || !src || !safeImageSource(src) || !/\/?>\s*$/.test(source)) return null;
  const dimension = (name: string) => { const value = attrs.get(name); return value === undefined ? null : /^\d+$/.test(value) ? imageDimension(Number(value)) : null; };
  const width = dimension('width'), height = dimension('height');
  if (attrs.has('width') && width === null || attrs.has('height') && height === null) return null;
  return { src, alt: attrs.get('alt') || '', title: attrs.get('title') ?? null, width, height, srcStart, srcEnd, quote: srcQuote };
}

export function imageTag(image: ImageAttributes) {
  if (!safeImageSource(image.src)) throw new Error(t("图片地址无效。"));
  const size = (['width', 'height'] as const).map(key => imageDimension(image[key]) ? ` ${key}="${image[key]}"` : '').join('');
  return `<img src="${escapeImageAttribute(image.src)}" alt="${escapeImageAttribute(image.alt)}"${image.title === null ? '' : ` title="${escapeImageAttribute(image.title)}"`}${size}>`;
}
export function rewriteImageSource(source: string, src: string): string | null {
  const image = parseImageTag(source); if (!image || !safeImageSource(src)) return null;
  return source.slice(0, image.srcStart) + escapeImageAttribute(src, image.quote) + source.slice(image.srcEnd);
}
export function imageSizeStyle(image: Pick<ImageAttributes, 'width' | 'height'>) {
  const width = imageDimension(image.width), height = imageDimension(image.height);
  return width ? `width:${width}px;height:auto;${height ? `aspect-ratio:${width}/${height};` : ''}` : height ? `height:${height}px;width:auto;` : '';
}

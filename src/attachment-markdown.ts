import { t } from '../electron/i18n.mjs';
import type { Definition, Image, ImageReference, Root, RootContent } from 'mdast';
import { parse, postprocess, preprocess } from 'micromark';
import { markdownProcessor } from './markdown-render.ts';
import { separateMetadata } from './markdown.ts';
import { parseImageTag, rewriteImageSource } from './image-syntax.ts';

export interface ImageReferenceRange { source: string; from: number; to: number; raw: string; kind: 'url' | 'reference' | 'html'; alt?: string; title?: string | null }
export interface MarkdownEdit { from: number; to: number; insert: string }

export function scanAttachmentImages(content: string): ImageReferenceRange[] {
  const { prefix, body } = separateMetadata(content);
  const processor = markdownProcessor(), tree = processor.parse(body) as Root;
  // AST positions identify eligible images. Concrete tokens locate their original
  // labels/destinations, including code spans or nested links containing brackets.
  const events = postprocess(parse({ extensions: processor.data('micromarkExtensions') }).document().write(preprocess()(body, 'utf8', true)));
  interface ImageToken { start: number; end: number; labelEnd?: number; destination?: { from: number; to: number } }
  const tokens = new Map<number, ImageToken>(), stack: ImageToken[] = [];
  for (const [event, token] of events) {
    if (token.type === 'image') {
      if (event === 'enter') { const image = { start: token.start.offset, end: token.end.offset }; tokens.set(image.start, image); stack.push(image); }
      else stack.pop();
    } else if (event === 'enter' && stack.length) {
      const image = stack[stack.length - 1];
      if (token.type === 'label' && token.start.offset === image.start) image.labelEnd = token.end.offset;
      if (token.type === 'resourceDestinationString' && image.labelEnd !== undefined && token.start.offset >= image.labelEnd) image.destination = { from: token.start.offset, to: token.end.offset };
    }
  }
  const definitions = new Map<string, Definition>(), result: ImageReferenceRange[] = [];
  const visit = (node: Root | RootContent, fn: (node: Root | RootContent) => void) => { fn(node); if ('children' in node) node.children.forEach(child => visit(child as RootContent, fn)); };
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  visit(tree, node => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const from = prefix.length + start, to = prefix.length + end, raw = content.slice(from, to);
    if (node.type === 'image' && node.url) {
      const token = tokens.get(start), range = token?.destination;
      if (!range || token?.end !== end) throw new Error(t("无法安全定位图片地址，请检查 Markdown 语法。"));
      result.push({ source: (node as Image).url, from: prefix.length + range.from, to: prefix.length + range.to, raw: body.slice(range.from, range.to), kind: 'url' });
    } else if (node.type === 'imageReference') {
      const definition = definitions.get((node as ImageReference).identifier);
      if (definition?.url) {
        const token = tokens.get(start);
        if (!token?.labelEnd || token.end !== end) throw new Error(t("无法安全定位图片引用，请检查 Markdown 语法。"));
        result.push({ source: definition.url, from, to, raw, kind: 'reference', alt: body.slice(start, token.labelEnd), title: definition.title });
      }
    } else if (node.type === 'html' || String(node.type) === 'mekiImage') {
      const image = parseImageTag(raw);
      if (image) result.push({ source: image.src, from, to, raw, kind: 'html' });
    }
  });
  return result.sort((a, b) => a.from - b.from);
}

export function attachmentEdits(content: string, images: ImageReferenceRange[], mappings: Array<{ source: string; relativePath: string }>): MarkdownEdit[] {
  const destinations = new Map(mappings.map(entry => [entry.source, entry.relativePath]));
  return images.flatMap(image => {
    const target = destinations.get(image.source);
    if (target === undefined || target === image.source) return [];
    if (content.slice(image.from, image.to) !== image.raw) throw new Error(t("文稿内容已变化，请重新整理。"));
    // Backend filenames are encoded; suffixes may contain Markdown delimiters.
    const url = target.replace(/[\s<>"'()\\]/g, character => encodeURIComponent(character).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`));
    let insert = url;
    if (image.kind === 'html') {
      const rewritten = rewriteImageSource(image.raw, target);
      if (!rewritten) throw new Error(t("图片标签不能安全更新。"));
      insert = rewritten;
    } else if (image.kind === 'reference') {
      const title = image.title == null ? '' : ` "${image.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      insert = `${image.alt}(${url}${title})`;
    }
    return [{ from: image.from, to: image.to, insert }];
  });
}

export function applyMarkdownEdits(content: string, changes: MarkdownEdit[]) {
  let end = 0, output = '';
  for (const change of changes) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < end || change.to < change.from || change.to > content.length) throw new Error(t("无效的图片引用范围。"));
    output += content.slice(end, change.from) + change.insert; end = change.to;
  }
  return output + content.slice(end);
}

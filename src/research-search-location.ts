import type { ResearchSearchLocator } from '../shared/research';
import type { Root, RootContent } from 'mdast';
import { headingText } from './markdown-extensions';
import { parseMarkdown } from './markdown-render';
import { separateMetadata } from './markdown';

type TextLocator = Extract<ResearchSearchLocator, { line: number }>;
const compact = (text: string) => text.normalize('NFKC').replace(/[\s\u200b]/g, '').toLocaleLowerCase();

function mark(node: HTMLElement) {
  node.setAttribute('data-research-search-target', '');
  node.scrollIntoView({ block: 'center', behavior: 'instant' });
  requestAnimationFrame(() => {
    if (node.isConnected && node.hasAttribute('data-research-search-target')) node.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
}

function findPassage(reader: HTMLElement, location: TextLocator, anchor: string) {
  const wanted = compact(anchor);
  const headings = 'h1,h2,h3,h4,h5,h6';
  let heading = '';
  const matches: HTMLElement[] = [];
  const others: HTMLElement[] = [];
  for (const node of reader.querySelectorAll<HTMLElement>(headings + ',p,tr,li,pre,blockquote')) {
    if (node.matches(headings)) { heading = compact(node.textContent ?? ''); continue; }
    if (node.matches('li,blockquote') && node.querySelector('p')) continue;
    if (node.matches('p') && node.closest('tr')) continue;
    const candidate = compact(node.textContent ?? '');
    const trial = location.trialId && node.matches('tr') && compact(node.children[0]?.textContent ?? '') === compact(location.trialId);
    if (!trial && (!wanted || !candidate.includes(wanted))) continue;
    (heading === compact(location.heading) ? matches : others).push(node);
  }
  return (matches.length ? matches : others)[location.occurrence];
}

function renderedAnchor(source: string, location: TextLocator) {
  const { prefix, body } = separateMetadata(source);
  const recordHeader = /^---[^\n]*\r?\n\s*\{/.test(prefix);
  const markdown = recordHeader ? body.replace(/^\r?\n/, '') : body;
  const line = recordHeader ? location.line : location.line - (prefix.match(/\n/g)?.length ?? 0);
  const tree = parseMarkdown(markdown);
  function atLine(node: Root | RootContent): RootContent | undefined {
    if (node.position && (line < node.position.start.line || line > node.position.end.line)) return;
    if (node.type === 'paragraph' || node.type === 'tableRow') return node;
    if ('children' in node) {
      for (const child of node.children) {
        const match = atLine(child as RootContent);
        if (match) return match;
      }
    }
  }
  const block = atLine(tree);
  if (!block?.position) return;
  // A source line is only a fallback when its content still agrees with the indexed anchor.
  const signature = (value: string) => compact(value).replace(/[^\p{L}\p{N}]/gu, '');
  const raw = markdown.slice(block.position.start.offset, block.position.end.offset);
  const saved = signature(location.anchor).slice(0, 32);
  const displayed = headingText(block);
  return saved && (signature(raw).includes(saved) || signature(displayed).includes(saved)) ? displayed : undefined;
}

export function revealResearchPassage(reader: HTMLElement, location: TextLocator, source: string) {
  reader.querySelector('[data-research-search-target]')?.removeAttribute('data-research-search-target');
  let node = findPassage(reader, location, location.anchor);
  if (!node) {
    const rendered = renderedAnchor(source, location);
    if (rendered) node = findPassage(reader, location, rendered);
  }
  if (!node) return false;
  mark(node);
  return true;
}

export function revealEvidenceLine(body: HTMLElement, locator: TextLocator) {
  const pre = body.querySelector('pre');
  if (!pre) return false;
  const lines = (pre.textContent ?? '').replace(/\r\n?/g, '\n').split('\n');
  const start = locator.line - 1;
  if (start < 0 || start >= lines.length) return false;
  const target = document.createElement('mark');
  target.textContent = lines[start];
  pre.replaceChildren(document.createTextNode(start ? lines.slice(0, start).join('\n') + '\n' : ''), target,
    document.createTextNode(start + 1 < lines.length ? '\n' + lines.slice(start + 1).join('\n') : ''));
  mark(target);
  return true;
}

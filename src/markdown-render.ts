import { t } from '../electron/i18n.mjs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import type { Root, RootContent } from 'mdast';
import type { Element, ElementContent, Properties } from 'hast';
import type { Handler, Handlers } from 'mdast-util-to-hast';
import { alertLabels, headingIds, headingText, remarkMoye, type MoyeAlert } from './markdown-extensions.ts';
import { separateMetadata } from './markdown.ts';
import { numberHeadings, numberedHeadingTitle } from './heading-numbering.ts';
import { imageSizeStyle, parseImageTag } from './image-syntax.ts';

export function markdownProcessor() {
  return unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkMoye).use(remarkStringify);
}

export function parseMarkdown(markdown: string): Root {
  const processor = markdownProcessor(), body = separateMetadata(markdown).body;
  return processor.runSync(processor.parse(body), { value: body }) as Root;
}

const element = (tagName: string, properties: Properties, children: ElementContent[] = []): Element => ({ type: 'element', tagName, properties, children });
const text = (value: string) => ({ type: 'text' as const, value });

/** General HTML remains text; standalone images use only strictly validated attributes. */
export function renderMarkdown(markdown: string, options: { headingNumbering?: boolean } = {}) {
  const tree = parseMarkdown(markdown);
  const headings: Array<{ node: RootContent; title: string; depth: number; id: string; number?: string }> = [];
  const expressions: Array<{ tex: string; display: boolean }> = [];
  const mathIndices = new Map<object, number>();
  const diagrams: string[] = [];
  const diagramIndices = new Map<object, number>();
  function collect(node: Root | RootContent) {
    if (node.type === 'heading') headings.push({ node, title: headingText(node), depth: node.depth, id: '' });
    if (node.type === 'inlineMath' || node.type === 'math' || node.type === 'code' && node.lang?.toLowerCase() === 'latex') {
      mathIndices.set(node, expressions.length);
      expressions.push({ tex: node.value, display: node.type !== 'inlineMath' });
    }
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') { diagramIndices.set(node, diagrams.length); diagrams.push(node.value); }
    if ('children' in node) node.children.forEach(child => collect(child as RootContent));
  }
  collect(tree);
  headingIds(headings.map(item => item.title)).forEach((id, index) => { headings[index].id = id; });
  if (options.headingNumbering) numberHeadings(headings.map(item => item.depth)).forEach((number, index) => { headings[index].number = number; });
  const mathSlot: Handler = (_state, node) => element(node.type === 'inlineMath' ? 'span' : 'div', { className: ['moye-math-slot'], dataMoyeMath: mathIndices.get(node) }, [text('value' in node ? String(node.value) : '')]);
  const handlers: Handlers = {
    heading: (state, node) => { const heading = headings.find(item => item.node === node)!; return element(`h${heading.depth}`, { id: heading.id, ...(heading.number ? { dataHeadingNumber: heading.number } : {}) }, state.all(node)); },
    moyeSub: (state, node) => element('sub', {}, state.all(node)),
    moyeSup: (state, node) => element('sup', {}, state.all(node)),
    moyeHighlight: (state, node) => element('mark', {}, state.all(node)),
    moyeEmoji: (_state, node) => element('span', { className: ['moye-emoji'], title: `:${node.name}:` }, [text(node.value)]),
    moyeToc: () => element('nav', { className: ['moye-toc'], ariaLabel: t("目录") }, [element('div', { className: ['moye-toc-title'] }, [text(t("目录"))]), element('ul', {}, headings.map(heading => element('li', { dataDepth: heading.depth }, [element('a', { href: `#${heading.id}` }, [text(numberedHeadingTitle(heading.title, heading.number))])])))]),
    moyeAlert: (state, node) => { const alert = node as MoyeAlert; return element('aside', { className: ['moye-alert'], dataKind: alert.kind }, [element('div', { className: ['moye-alert-title'] }, [text(alertLabels[alert.kind] || alert.kind)]), ...state.all(node)]); },
    moyeRaw: (_state, node) => element('pre', { className: ['moye-raw-html'] }, [element('code', {}, [text(node.value)])]),
    moyeImage: (_state, node) => {
      const image = parseImageTag(node.value)!;
      return element('p', {}, [element('img', { src: image.src, alt: image.alt, ...(image.title !== null ? { title: image.title } : {}), ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}), ...(image.width || image.height ? { style: imageSizeStyle(image) } : {}) })]);
    },
    html: (_state, node) => element('code', { className: ['moye-raw-inline'] }, [text(node.value)]),
    inlineMath: mathSlot,
    math: mathSlot,
    code: (state, node) => {
      if (mathIndices.has(node)) return mathSlot(state, node, undefined);
      if (diagramIndices.has(node)) return element('div', { className: ['moye-diagram-slot'], dataMoyeDiagram: diagramIndices.get(node) }, [text(node.value)]);
      return element('pre', {}, [element('code', node.lang ? { className: [`language-${node.lang}`] } : {}, [text(node.value + '\n')])]);
    },
  };
  const processor = unified().use(remarkRehype, { handlers, footnoteLabel: t("脚注"), footnoteBackLabel: t("返回正文"), clobberPrefix: 'moye-' }).use(rehypeStringify);
  return { html: processor.stringify(processor.runSync(tree)), expressions, diagrams };
}

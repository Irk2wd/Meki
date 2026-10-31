import { t } from '../electron/i18n.mjs';
import { $inputRule, $markSchema, $nodeSchema, $prose, $view } from '@milkdown/kit/utils';
import { InitReady, remarkPluginsCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { markRule } from '@milkdown/kit/prose';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { footnoteReferenceSchema, strikethroughSchema } from '@milkdown/kit/preset/gfm';
import { alertLabels, emoji, headingIds, remarkMoye } from './markdown-extensions';
import { numberHeadings, numberedHeadingTitle } from './heading-numbering';

// Run before Crepe's soft-break and HTML transforms, while original source positions remain intact.
export const moyeRemark: MilkdownPlugin = ctx => async () => {
  await ctx.wait(InitReady);
  const entry = { plugin: remarkMoye, options: {} };
  ctx.update(remarkPluginsCtx, plugins => [entry, ...plugins]);
  return () => { ctx.update(remarkPluginsCtx, plugins => plugins.filter(plugin => plugin !== entry)); };
};

function spanSchema(name: string, type: string, tag: string) {
  return $markSchema(name, () => ({
    parseDOM: [{ tag }], toDOM: () => [tag, 0],
    parseMarkdown: { match: node => node.type === type, runner: (state, node, mark) => { state.openMark(mark).next(node.children).closeMark(mark); } },
    toMarkdown: { match: mark => mark.type.name === name, runner: (state, mark) => { state.withMark(mark, type); } },
  }));
}
export const subSchema = spanSchema('moye_sub', 'moyeSub', 'sub');
export const supSchema = spanSchema('moye_sup', 'moyeSup', 'sup');
export const highlightSchema = spanSchema('moye_highlight', 'moyeHighlight', 'mark');

export const emojiSchema = $nodeSchema('moye_emoji', () => ({
  inline: true, group: 'inline', atom: true,
  attrs: { name: { default: '' } },
  toDOM: node => ['span', { class: 'moye-emoji', 'data-emoji': node.attrs.name, title: `:${node.attrs.name}:` }, emoji[node.attrs.name] || `:${node.attrs.name}:`],
  parseDOM: [{ tag: 'span[data-emoji]', getAttrs: dom => ({ name: dom.dataset.emoji }) }],
  parseMarkdown: { match: node => node.type === 'moyeEmoji', runner: (state, node, type) => { state.addNode(type, { name: node.name }); } },
  toMarkdown: { match: node => node.type.name === 'moye_emoji', runner: (state, node) => { state.addNode('moyeEmoji', undefined, emoji[node.attrs.name], { name: node.attrs.name }); } },
}));

export const tocSchema = $nodeSchema('moye_toc', () => ({
  group: 'block', atom: true, selectable: true,
  attrs: { marker: { default: '[TOC]' } },
  toDOM: node => ['nav', { class: 'moye-toc', 'data-toc': node.attrs.marker, contenteditable: 'false', 'aria-label': t("目录") }, t("目录")],
  parseDOM: [{ tag: 'nav[data-toc]', getAttrs: dom => ({ marker: dom.dataset.toc }) }],
  parseMarkdown: { match: node => node.type === 'moyeToc', runner: (state, node, type) => { state.addNode(type, { marker: node.value }); } },
  toMarkdown: { match: node => node.type.name === 'moye_toc', runner: (state, node) => { state.addNode('moyeToc', undefined, node.attrs.marker); } },
}));

export const alertSchema = $nodeSchema('moye_alert', () => ({
  group: 'block', content: 'block+', defining: true,
  attrs: { kind: { default: 'note' } },
  toDOM: node => ['aside', { class: 'moye-alert', 'data-kind': node.attrs.kind }, ['div', { class: 'moye-alert-title', contenteditable: 'false' }, alertLabels[node.attrs.kind] || node.attrs.kind], ['div', { class: 'moye-alert-content' }, 0]],
  parseDOM: [{ tag: 'aside.moye-alert', getAttrs: dom => ({ kind: dom.dataset.kind }), contentElement: '.moye-alert-content' }],
  parseMarkdown: { match: node => node.type === 'moyeAlert', runner: (state, node, type) => { state.openNode(type, { kind: node.kind }).next(node.children).closeNode(); } },
  toMarkdown: { match: node => node.type.name === 'moye_alert', runner: (state, node) => { state.openNode('moyeAlert', undefined, { kind: node.attrs.kind }).next(node.content).closeNode(); } },
}));

export const rawSchema = $nodeSchema('moye_raw', () => ({
  group: 'block', atom: true, selectable: true,
  attrs: { value: { default: '' } },
  toDOM: node => ['pre', { class: 'moye-raw-html', 'data-raw-html': node.attrs.value, title: t("原始 HTML；在源码模式中编辑") }, ['code', node.attrs.value]],
  parseDOM: [{ tag: 'pre[data-raw-html]', getAttrs: dom => ({ value: dom.dataset.rawHtml }) }],
  parseMarkdown: { match: node => node.type === 'moyeRaw', runner: (state, node, type) => { state.addNode(type, { value: node.value }); } },
  toMarkdown: { match: node => node.type.name === 'moye_raw', runner: (state, node) => { state.addNode('moyeRaw', undefined, node.attrs.value); } },
}));

export function documentHeadings(doc: Node) {
  const headings: Array<{ title: string; depth: number; pos: number; size: number; id: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    let title = '';
    node.descendants(child => { if (child.isText) title += child.text; else if (child.type.name === 'moye_emoji') title += emoji[child.attrs.name] || ''; else if (child.type.name === 'math_inline') title += child.attrs.value; });
    headings.push({ title, depth: node.attrs.level, pos, size: node.nodeSize, id: '' });
  });
  headingIds(headings.map(heading => heading.title)).forEach((id, index) => { headings[index].id = id; });
  return headings;
}

const headingKey = new PluginKey<boolean>('moye-heading-numbering');
export function setHeadingNumbering(view: EditorView, enabled: boolean) {
  if (headingKey.getState(view.state) !== enabled) view.dispatch(view.state.tr.setMeta(headingKey, enabled).setMeta('addToHistory', false));
}

function fillToc(dom: HTMLElement, view: EditorView) {
  const headings = documentHeadings(view.state.doc), numbered = headingKey.getState(view.state);
  const numbers = numbered ? numberHeadings(headings.map(heading => heading.depth)) : [];
  const signature = JSON.stringify([numbered, headings.map(({ title, depth, id }) => [title, depth, id])]);
  if (dom.dataset.headings === signature) return;
  dom.dataset.headings = signature;
  const label = document.createElement('div'); label.className = 'moye-toc-title'; label.textContent = t("目录");
  const list = document.createElement('ul');
  for (const [index, heading] of headings.entries()) {
    const item = document.createElement('li'); item.dataset.depth = String(heading.depth);
    const link = document.createElement('a'); link.setAttribute('href', `#${heading.id}`); link.textContent = numberedHeadingTitle(heading.title, numbers[index]);
    item.append(link); list.append(item);
  }
  if (!headings.length) { const item = document.createElement('li'); item.textContent = t("添加标题后会显示在这里"); list.append(item); }
  dom.replaceChildren(label, list);
}

const tocView = $view(tocSchema.node, () => (node, view) => {
  const dom = document.createElement('nav'); dom.className = 'moye-toc'; dom.dataset.toc = node.attrs.marker; dom.contentEditable = 'false'; dom.setAttribute('aria-label', t("目录")); fillToc(dom, view);
  return { dom, ignoreMutation: () => true };
});
const footnoteKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
function footnoteNumbers(doc: Node) {
  const numbers = new Map<string, number>();
  doc.descendants(node => { if (node.type.name === 'footnote_reference') { const key = footnoteKey(node.attrs.label); if (!numbers.has(key)) numbers.set(key, numbers.size + 1); } });
  return numbers;
}
const footnoteView = $view(footnoteReferenceSchema.node, () => (node, view) => {
  const dom = document.createElement('sup'); dom.dataset.type = 'footnote_reference'; dom.dataset.label = node.attrs.label; dom.contentEditable = 'false';
  const link = document.createElement('a'); link.href = '#' + encodeURIComponent('moye-fn-' + footnoteKey(node.attrs.label)); link.textContent = String(footnoteNumbers(view.state.doc).get(footnoteKey(node.attrs.label)) || node.attrs.label); dom.append(link);
  return { dom, ignoreMutation: () => true };
});
const headingPlugin = $prose(() => new Plugin({
  key: headingKey,
  state: { init: () => false, apply: (tr, enabled) => tr.getMeta(headingKey) ?? enabled },
  props: { decorations: state => {
    const headings = documentHeadings(state.doc), numbers = headingKey.getState(state) ? numberHeadings(headings.map(heading => heading.depth)) : [];
    const decorations = headings.map((heading, index) => Decoration.node(heading.pos, heading.pos + heading.size, { id: heading.id, ...(numbers[index] ? { 'data-heading-number': numbers[index] } : {}) }));
    state.doc.descendants((node, pos) => { if (node.type.name === 'footnote_definition') decorations.push(Decoration.node(pos, pos + node.nodeSize, { id: 'moye-fn-' + footnoteKey(node.attrs.label) })); });
    return DecorationSet.create(state.doc, decorations);
  } },
  view: () => ({ update: (view, previous) => {
    if (previous.doc.eq(view.state.doc) && headingKey.getState(previous) === headingKey.getState(view.state)) return;
    view.dom.querySelectorAll<HTMLElement>('nav.moye-toc').forEach(dom => fillToc(dom, view));
    const numbers = footnoteNumbers(view.state.doc);
    view.dom.querySelectorAll<HTMLElement>('sup[data-type="footnote_reference"]').forEach(dom => { const link = dom.querySelector('a'); if (link) link.textContent = String(numbers.get(footnoteKey(dom.dataset.label || '')) || dom.dataset.label); });
  } }),
}));

const inlineRules = [
  $inputRule(ctx => markRule(/(?<![\\~])~([^~\s]+)(?<!\\)~$/, subSchema.type(ctx))),
  $inputRule(ctx => markRule(/(?<![\\^])\^([^\^\s]+)(?<!\\)\^$/, supSchema.type(ctx))),
  $inputRule(ctx => markRule(/(?<![\\=])==([^=]+)(?<!\\)==$/, highlightSchema.type(ctx))),
  $inputRule(ctx => markRule(/(?<![\\~])~~([^~]+)(?<!\\)~~$/, strikethroughSchema.type(ctx))),
  $inputRule(ctx => new InputRule(/(?<!\\):([\w+-]+):$/, (state, match, start, end) => emoji[match[1]] ? state.tr.replaceWith(start, end, emojiSchema.type(ctx).create({ name: match[1] })) : null)),
  $inputRule(ctx => new InputRule(/^\[toc\] $/i, (state, match, start, end) => {
    const from = state.doc.resolve(start); if (from.parent.type.name !== 'paragraph') return null;
    return state.tr.replaceWith(from.before(), end, tocSchema.type(ctx).create({ marker: match[0].trim() }));
  })),
  $inputRule(ctx => new InputRule(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\] $/i, (state, match, start, end) => {
    const from = state.doc.resolve(start); if (from.depth < 2 || from.node(from.depth - 1).type.name !== 'blockquote') return null;
    return state.tr.delete(start, end).setNodeMarkup(from.before(from.depth - 1), alertSchema.type(ctx), { kind: match[1].toLowerCase() });
  })),
];

export const markdownEditorExtensions = [moyeRemark, subSchema, supSchema, highlightSchema, emojiSchema, tocSchema, alertSchema, rawSchema, tocView, footnoteView, headingPlugin, ...inlineRules].flat();

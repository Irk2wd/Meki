import { t } from '../electron/i18n.mjs';
import type { Root, RootContent, PhrasingContent, Parent, Literal } from 'mdast';
import type { Processor } from 'unified';
import type { Code, Construct, Event, Extension, Resolver, State, Token } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Handle, Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { resolveAll } from 'micromark-util-resolve-all';
import { classifyCharacter } from 'micromark-util-classify-character';
import { parseImageTag } from './image-syntax.ts';

export interface MoyeInline extends Parent { type: 'moyeSub' | 'moyeSup' | 'moyeHighlight'; children: PhrasingContent[] }
export interface MoyeEmoji extends Literal { type: 'moyeEmoji'; value: string; name: string }
export interface MoyeToc extends Literal { type: 'moyeToc'; value: string }
export interface MoyeRaw extends Literal { type: 'moyeRaw'; value: string }
export interface MoyeImage extends Literal { type: 'moyeImage'; value: string }
export interface MoyeAlert extends Parent { type: 'moyeAlert'; kind: string; children: RootContent[] }
declare module 'mdast' {
  interface PhrasingContentMap { moyeInline: MoyeInline; moyeEmoji: MoyeEmoji }
  interface RootContentMap { moyeInline: MoyeInline; moyeEmoji: MoyeEmoji; moyeToc: MoyeToc; moyeAlert: MoyeAlert; moyeRaw: MoyeRaw; moyeImage: MoyeImage }
}
declare module 'micromark-util-types' {
  interface TokenTypeMap { moyeDelimiter: 'moyeDelimiter'; moyeSequence: 'moyeSequence'; moyeSub: 'moyeSub'; moyeSup: 'moyeSup'; moyeHighlight: 'moyeHighlight'; moyeEmoji: 'moyeEmoji' }
}

/** A deliberately small, stable vocabulary. Unknown names remain literal Markdown. */
export const emoji: Readonly<Record<string, string>> = Object.freeze({
  smile: '😄', smiling: '😊', grin: '😁', joy: '😂', wink: '😉', heart: '❤️',
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', tada: '🎉', rocket: '🚀',
  warning: '⚠️', bulb: '💡', star: '⭐', fire: '🔥', eyes: '👀', thinking: '🤔',
  check: '✅', white_check_mark: '✅', x: '❌', memo: '📝', sparkles: '✨',
});
export const alertKinds = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export const alertLabels: Record<string, string> = { note: t("备注"), tip: t("提示"), important: t("重要"), warning: t("警告"), caution: t("注意") };

type DelimiterToken = Token & { moyeName?: string; moyeOpen?: boolean; moyeClose?: boolean };

/** Resolve actual micromark delimiter tokens, never text inside code, math or escapes. */
function delimiter(marker: number, size: number, type: MoyeInline['type']): Construct {
  const resolve: Resolver = (events, context) => {
    for (let close = 0; close < events.length; close++) {
      const closing = events[close][1] as DelimiterToken;
      if (events[close][0] !== 'enter' || closing.type !== 'moyeDelimiter' || closing.moyeName !== type || !closing.moyeClose) continue;
      for (let open = close - 1; open >= 0; open--) {
        const opening = events[open][1] as DelimiterToken;
        if (events[open][0] !== 'exit' || opening.type !== 'moyeDelimiter' || opening.moyeName !== type || !opening.moyeOpen) continue;
        // Sub/sup are single-line spans without spaces; escaped spaces remain explicit source.
        const innerSource = context.sliceSerialize({ start: opening.end, end: closing.start } as Token);
        if (!innerSource || (type !== 'moyeHighlight' && /\s/.test(innerSource))) break;
        opening.type = closing.type = 'moyeSequence';
        const wrapper: Token = { type, start: { ...opening.start }, end: { ...closing.end } };
        const inner = resolveAll(context.parser.constructs.insideSpan.null || [], events.slice(open + 1, close), context);
        const replacement: Event[] = [['enter', wrapper, context], events[open - 1], events[open], ...inner, events[close], events[close + 1], ['exit', wrapper, context]];
        events.splice(open - 1, close - open + 3, ...replacement);
        close = open + replacement.length - 2;
        break;
      }
    }
    for (const event of events) if (event[1].type === 'moyeDelimiter' && (event[1] as DelimiterToken).moyeName === type) event[1].type = 'data';
    return events;
  };
  return {
    name: type, resolveAll: resolve,
    tokenize(effects, ok, nok) {
      const previous = this.previous;
      const escaped = this.events.at(-1)?.[1].type === 'characterEscape';
      let count = 0;
      return start;
      function start(code: Code): State | undefined {
        if (previous === marker && !escaped) return nok(code);
        effects.enter('moyeDelimiter');
        return sequence(code);
      }
      function sequence(code: Code): State | undefined {
        if (code === marker) { if (++count > size) return nok(code); effects.consume(code); return sequence; }
        if (count !== size) return nok(code);
        const before = classifyCharacter(previous), after = classifyCharacter(code);
        const token = effects.exit('moyeDelimiter') as DelimiterToken;
        token.moyeName = type;
        token.moyeOpen = !after || after === 2 && Boolean(before);
        token.moyeClose = !before || before === 2 && Boolean(after);
        return ok(code);
      }
    },
  };
}

function emojiSyntax(): Construct {
  return { name: 'moyeEmoji', tokenize(effects, ok, nok) {
    let name = '';
    return start;
    function start(code: Code): State | undefined { effects.enter('moyeEmoji'); effects.consume(code); return body; }
    function body(code: Code): State | undefined {
      if (code === 58 && emoji[name]) { effects.consume(code); effects.exit('moyeEmoji'); return ok; }
      if (code === null || name.length > 32 || !/[\w+-]/.test(String.fromCharCode(code))) return nok(code);
      name += String.fromCharCode(code); effects.consume(code); return body;
    }
  } };
}

function syntax(): Extension {
  const sub = delimiter(126, 1, 'moyeSub'), sup = delimiter(94, 1, 'moyeSup'), highlight = delimiter(61, 2, 'moyeHighlight');
  return { text: { 126: sub, 94: sup, 61: highlight, 58: emojiSyntax() }, insideSpan: { null: [sub, sup, highlight] }, attentionMarkers: { null: [126, 94, 61] } };
}

function fromMarkdown(): FromMarkdownExtension {
  const extension: FromMarkdownExtension = { enter: {}, exit: {}, canContainEols: ['moyeHighlight'] };
  for (const type of ['moyeSub', 'moyeSup', 'moyeHighlight'] as const) {
    extension.enter![type] = function(token) { this.enter({ type, children: [] }, token); };
    extension.exit![type] = function(token) { this.exit(token); };
  }
  extension.enter!.moyeEmoji = function(token) { const name = this.sliceSerialize(token).slice(1, -1); this.enter({ type: 'moyeEmoji', name, value: emoji[name] }, token); };
  extension.exit!.moyeEmoji = function(token) { this.exit(token); };
  return extension;
}

function spanHandler(marker: string): Handle {
  const handler: Handle = (node, _parent, state, info) => {
    const tracker = state.createTracker(info);
    const exit = state.enter('phrasing');
    let result = tracker.move(marker);
    result += state.containerPhrasing(node as MoyeInline, { ...tracker.current(), before: marker, after: marker });
    result += tracker.move(marker); exit(); return result;
  };
  (handler as Handle & { peek: () => string }).peek = () => marker[0];
  return handler;
}

function toMarkdown(): ToMarkdownExtension {
  return {
    unsafe: [{ character: '~', inConstruct: 'phrasing' }, { character: '^', inConstruct: 'phrasing' }, { character: '=', after: '=', inConstruct: 'phrasing' }, { character: ':', after: '[\\w+-]+:', inConstruct: 'phrasing' }],
    handlers: {
      moyeSub: spanHandler('~'), moyeSup: spanHandler('^'), moyeHighlight: spanHandler('=='),
      moyeEmoji: (node) => `:${(node as MoyeEmoji).name}:`,
      moyeToc: (node) => (node as MoyeToc).value || '[TOC]',
      moyeRaw: (node) => (node as MoyeRaw).value,
      moyeImage: (node) => (node as MoyeImage).value,
      moyeAlert: (node, _parent, state, info) => {
        const alert = node as MoyeAlert, exit = state.enter('blockquote'), tracker = state.createTracker(info);
        tracker.move('> '); tracker.shift(2);
        const body = state.containerFlow(alert, tracker.current());
        exit(); return `> [!${alert.kind.toUpperCase()}]\n` + state.indentLines(body, (line, _index, blank) => '>' + (blank ? '' : ' ') + line);
      },
    },
  };
}

function transformBlocks(node: Root | RootContent, source: string) {
  if (!('children' in node)) return;
  node.children = node.children.map(child => {
    if (child.type === 'paragraph' && child.children.length === 1 && child.children[0].type === 'text') {
      const raw = source.slice(child.position?.start.offset, child.position?.end.offset);
      if (/^\[toc\]$/i.test(raw.trim())) return { type: 'moyeToc', value: raw.trim(), position: child.position } as MoyeToc;
    }
    if (child.type === 'blockquote') {
      const paragraph = child.children[0], first = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
      const match = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.exec(first.value) : null;
      if (match && first?.type === 'text' && source.slice(first.position?.start.offset).startsWith(match[0].trimEnd())) {
        first.value = first.value.slice(match[0].length);
        const alert: MoyeAlert = { type: 'moyeAlert', kind: match[1].toLowerCase(), children: child.children, position: child.position };
        if (!first.value && paragraph?.type === 'paragraph') paragraph.children.shift();
        if (paragraph?.type === 'paragraph' && !paragraph.children.length && alert.children.length > 1) alert.children.shift();
        transformBlocks(alert, source); return alert;
      }
    }
    if (child.type === 'html' && ['root', 'blockquote', 'listItem', 'moyeAlert', 'footnoteDefinition'].includes(node.type)) return { type: parseImageTag(child.value) ? 'moyeImage' : 'moyeRaw', value: child.value, position: child.position } as MoyeImage | MoyeRaw;
    transformBlocks(child as RootContent, source); return child;
  }) as typeof node.children;
}

/** Shared by Milkdown and HTML export, with syntax handled before AST transforms. */
export function remarkMoye(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ||= []).push(syntax());
  (data.fromMarkdownExtensions ||= []).push(fromMarkdown());
  (data.toMarkdownExtensions ||= []).push(toMarkdown());
  return (tree: Root, file: { value: unknown }) => transformBlocks(tree, String(file.value || ''));
}

export function headingText(node: { type?: string; value?: string; children?: unknown[] }): string {
  if (node.type === 'moyeEmoji' || node.type === 'inlineMath' || node.type === 'text' || node.type === 'inlineCode') return node.value || '';
  return node.children?.map(child => headingText(child as Parameters<typeof headingText>[0])).join('') || '';
}
export function headingIds(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map(title => {
    const base = title.normalize('NFC').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    let id = base, suffix = 1; while (used.has(id)) id = `${base}-${suffix++}`; used.add(id); return id;
  });
}

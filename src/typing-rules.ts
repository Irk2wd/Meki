export type PairPreference = 'default' | 'on' | 'off';
export interface TypingSettings {
  typingAutoPair: PairPreference;
  typingMarkdownPairs: boolean;
  typingSmartQuotes: boolean;
  typingSmartDashes: boolean;
}
export const typingDefaults: TypingSettings = { typingAutoPair: 'default', typingMarkdownPairs: false, typingSmartQuotes: false, typingSmartDashes: false };
export interface PairToken { open: string; close: string; trigger: string }
export interface TypingContext {
  text: string; from: number; to: number; input: string;
  composing?: boolean; protected?: boolean; tracked?: PairToken;
}
export type TypingAction =
  | { kind: 'replace'; from: number; to: number; text: string; cursor: number }
  | { kind: 'wrap'; from: number; to: number; pair: PairToken }
  | { kind: 'skip'; cursor: number }
  | { kind: 'mark'; from: number; to: number; mark: string }
  | { kind: 'math'; from: number; to: number; tex: string };
const brackets: Record<string, string> = { '(': ')', '[': ']', '{': '}', '（': '）', '【': '】', '「': '」', '『': '』', '《': '》' };
const marks: Record<string, string> = { '*': 'emphasis', '_': 'emphasis', '**': 'strong', '__': 'strong', '`': 'inlineCode', '~': 'moye_sub', '~~': 'strike_through', '^': 'moye_sup', '=': 'moye_highlight', '==': 'moye_highlight' };
const word = /[\p{L}\p{N}]/u;

/** An unfinished $... expression is still prose until Milkdown parses it. */
export function insidePendingMath(text: string, cursor: number) {
  let open = false;
  for (let i = 0; i < cursor; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '$') open = !open;
  }
  return open;
}
function eligible(context: TypingContext) {
  return !context.composing && !context.protected && Number.isInteger(context.from) && Number.isInteger(context.to) &&
    context.from >= 0 && context.from <= context.to && context.to <= context.text.length &&
    !insidePendingMath(context.text, context.from);
}
export function typingAction(context: TypingContext, settings: TypingSettings = typingDefaults): TypingAction | null {
  if (!eligible(context)) return null;
  const { text, from, to, input, tracked } = context, before = text.slice(0, from), after = text.slice(to), selected = text.slice(from, to);
  if (settings.typingAutoPair === 'on' && from === to && tracked && input === tracked.trigger && after.startsWith(tracked.close)) return { kind: 'skip', cursor: from + tracked.close.length };
  if (settings.typingMarkdownPairs && selected && !/[\r\n]/.test(selected)) {
    if (input === '$') return { kind: 'math', from, to, tex: selected };
    if (marks[input] && (!['~', '^'].includes(input) || !/\s/.test(selected))) return { kind: 'mark', from, to, mark: marks[input] };
  }
  if (input.length !== 1 || /[\r\n]/.test(input)) return null;
  const quote = input === '"' || input === "'";
  const openingQuote = !before || /[\s([{（【「『《—–]$/u.test(before);
  const apostrophe = input === "'" && word.test(before.slice(-1));
  const pair: PairToken | undefined = brackets[input] ? { open: input, close: brackets[input], trigger: brackets[input] }
    : quote ? settings.typingSmartQuotes
      ? { open: input === '"' ? '“' : '‘', close: input === '"' ? '”' : '’', trigger: input }
      : { open: input, close: input, trigger: input }
    : undefined;
  if (settings.typingAutoPair === 'on' && pair && (selected || (!quote || openingQuote && !apostrophe) && (!after || /^[\s)\]}）】」』》.,!?，。！？;:；：]/u.test(after)))) return { kind: 'wrap', from, to, pair };
  if (settings.typingSmartQuotes && quote) {
    const replacement = openingQuote && !apostrophe ? pair!.open : pair!.close;
    return { kind: 'replace', from, to, text: replacement, cursor: from + replacement.length };
  }
  // Leave a line of hyphens available for Markdown rules and list markers.
  if (settings.typingSmartDashes && input === '-' && from === to && before.endsWith('-') && !/^\s*-+$/.test(before) && !before.endsWith('--')) return { kind: 'replace', from: from - 1, to, text: '—', cursor: from };
  return null;
}
export function pairedBackspace(context: Omit<TypingContext, 'input'>, settings: TypingSettings = typingDefaults): TypingAction | null {
  if (settings.typingAutoPair !== 'on' || !eligible({ ...context, input: '' }) || context.from !== context.to || !context.tracked) return null;
  const { from, text, tracked } = context;
  if (!text.slice(0, from).endsWith(tracked.open) || !text.slice(from).startsWith(tracked.close)) return null;
  return { kind: 'replace', from: from - tracked.open.length, to: from + tracked.close.length, text: '', cursor: from - tracked.open.length };
}

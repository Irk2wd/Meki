import { t } from '../electron/i18n.mjs';
export interface SearchOptions { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export interface SearchSegment { id: number; text: string }
export interface SearchMatch { segment: number; from: number; to: number; text: string; captures: Array<string | undefined>; groups?: Record<string, string> }
export interface SearchResult { matches: SearchMatch[]; error: string | null; truncated: boolean }
export const MAX_MATCHES = 10000;
const word = /[\p{L}\p{M}\p{N}_]/u;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shared matching rules; the UI runs this in a disposable worker to bound regex runtime. */
export function searchText(segments: SearchSegment[], options: SearchOptions): SearchResult {
  if (!options.query) return { matches: [], error: null, truncated: false };
  if (options.query.length > 4096) return { matches: [], error: t("查找内容不能超过 4096 个字符。"), truncated: false };
  let pattern: RegExp;
  try { pattern = new RegExp(options.regex ? options.query : escapeRegex(options.query), `gmu${options.caseSensitive ? '' : 'i'}`); }
  catch (error) { return { matches: [], error: t("正则表达式无效：{0}", (error as Error).message), truncated: false }; }
  const matches: SearchMatch[] = [];
  for (const segment of segments) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment.text))) {
      const from = match.index, to = from + match[0].length;
      const before = [...segment.text.slice(Math.max(0, from - 2), from)].at(-1) || '';
      const after = String.fromCodePoint(segment.text.codePointAt(to) || 0);
      if (!options.wholeWord || !word.test(before) && !word.test(after)) {
        if (matches.length === MAX_MATCHES) return { matches, error: null, truncated: true };
        matches.push({ segment: segment.id, from, to, text: match[0], captures: match.slice(1), groups: match.groups });
      }
      if (!match[0]) pattern.lastIndex = to + ((segment.text.codePointAt(to) || 0) > 0xffff ? 2 : 1);
    }
  }
  return { matches, error: null, truncated: false };
}

/** JavaScript replacement notation, using the original segment (including $` and $'). */
export function replacementText(replacement: string, match: SearchMatch, source: string, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, value: string) => {
    if (value === '$') return '$';
    if (value === '&') return match.text;
    if (value === '`') return source.slice(0, match.from);
    if (value === "'") return source.slice(match.to);
    if (value[0] === '<') return match.groups ? match.groups[value.slice(1, -1)] || '' : token;
    const index = Number(value);
    if (index > 0 && index <= match.captures.length) return match.captures[index - 1] || '';
    if (value.length === 2 && Number(value[0]) > 0 && Number(value[0]) <= match.captures.length) return (match.captures[Number(value[0]) - 1] || '') + value[1];
    return token;
  });
}

export function countWords(text: string) {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  return cjk + (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}

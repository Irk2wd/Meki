import type { Settings } from '../shared/moye';

export type CodeOptions = Pick<Settings, 'codeWrap' | 'codeIndentSize' | 'codeUseTabs' | 'codeTabSize' | 'codeAutoIndent' | 'codeLanguageMode' | 'codeDefaultLanguage' | 'codeLastLanguage'>;
export const codeDefaults: CodeOptions = {
  codeWrap: false, codeIndentSize: 2, codeUseTabs: false, codeTabSize: 4,
  codeAutoIndent: true, codeLanguageMode: 'plain', codeDefaultLanguage: '', codeLastLanguage: '',
};
export const validCodeLanguage = (value: string) => /^[a-zA-Z0-9_+.#-]{0,40}$/.test(value);
export function newCodeLanguage(options: CodeOptions): string {
  return options.codeLanguageMode === 'default' ? options.codeDefaultLanguage : options.codeLanguageMode === 'last' ? options.codeLastLanguage : '';
}
/** Screen/export use the same tab width. Printed code always wraps, including lazy placeholders. */
export function codeAppearance(input: Partial<CodeOptions & Pick<Settings, 'theme'>> = {}, scope = '.moye-document'): string {
  const settings = { ...codeDefaults, ...input };
  const tabSize = Number.isInteger(settings.codeTabSize) && settings.codeTabSize >= 1 && settings.codeTabSize <= 8 ? settings.codeTabSize : 4;
  const light = '--code-comment:#626b65;--code-keyword:#793e93;--code-string:#28693b;--code-number:#8c501d;--code-function:#23677f;';
  const dark = '--code-comment:#a0aea3;--code-keyword:#dbadec;--code-string:#b2d990;--code-number:#e2b77d;--code-function:#91cbe1;';
  return `${scope}{${settings.theme === 'night' ? dark : light}}
${['comment', 'keyword', 'string', 'number', 'function'].map(kind => `${scope} .moye-code-${kind}{color:var(--code-${kind});}`).join('')}
${scope} pre,${scope} pre code{white-space:${settings.codeWrap ? 'pre-wrap' : 'pre'};overflow-wrap:${settings.codeWrap ? 'anywhere' : 'normal'};tab-size:${tabSize};}
@media print{${scope} pre,${scope} pre code,${scope} .cm-content,${scope} .cm-line{white-space:pre-wrap!important;overflow-wrap:anywhere!important;word-break:break-word!important;} ${scope} pre,${scope} .cm-scroller{overflow:visible!important;} ${scope} .cm-line{max-width:100%!important;} ${scope} .cm-scroller{display:block!important;}${scope} .cm-gutters{display:none!important;}}`;
}

import { HighlightStyle, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightTree, tags } from '@lezer/highlight';

export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'moye-code-comment' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], class: 'moye-code-keyword' },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], class: 'moye-code-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'moye-code-number' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className, tags.tagName], class: 'moye-code-function' },
]);

/** Export uses the editor's bundled parsers and token classes, never a document-provided script. */
export async function highlightExportCode(root: HTMLElement) {
  await Promise.all([...root.querySelectorAll<HTMLElement>('pre > code')].map(async code => {
    const name = [...code.classList].find(value => value.startsWith('language-'))?.slice(9);
    const language = name ? LanguageDescription.matchLanguageName(languages, name, false) : null;
    if (!language) return;
    const source = code.textContent || '';
    try {
      const support = await language.load(), result = document.createDocumentFragment();
      let offset = 0;
      highlightTree(support.language.parser.parse(source), codeHighlightStyle, (from, to, classes) => {
        result.append(document.createTextNode(source.slice(offset, from)));
        const span = document.createElement('span'); span.className = classes; span.textContent = source.slice(from, to); result.append(span); offset = to;
      });
      result.append(document.createTextNode(source.slice(offset))); code.replaceChildren(result);
    } catch { /* Unsupported or failed parsers leave the complete original code visible. */ }
  }));
}

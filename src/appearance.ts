import { t } from '../electron/i18n.mjs';
import postcss, { type Container } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { Settings } from '../shared/meki';
import { codeAppearance, type CodeOptions } from './code-options.ts';

const properties = new Set((
  'color background-color font font-family font-size font-style font-weight font-variant font-variant-numeric font-feature-settings font-kerning ' +
  'line-height letter-spacing word-spacing text-align text-indent text-transform text-decoration text-decoration-color text-decoration-style text-decoration-thickness text-underline-offset text-shadow ' +
  'white-space overflow-wrap word-break hyphens vertical-align ' +
  'margin margin-top margin-right margin-bottom margin-left margin-inline margin-block margin-inline-start margin-inline-end ' +
  'padding padding-top padding-right padding-bottom padding-left padding-inline padding-block padding-inline-start padding-inline-end ' +
  'border border-width border-style border-color border-top border-right border-bottom border-left border-radius border-collapse border-spacing ' +
  'width min-width max-width height min-height max-height box-sizing opacity box-shadow list-style-type list-style-position ' +
  'break-before break-after break-inside page-break-before page-break-after page-break-inside orphans widows'
).split(/\s+/));

/** Only typography rules inside document content are accepted; CSS cannot load resources or alter app controls. */
export function normalizeCustomCss(css: string, scope = '.meki-document'): string {
  if (new TextEncoder().encode(css).length > 256 * 1024) throw new Error(t("自定义 CSS 不能超过 256 KiB。"));
  if (!/^\.[a-z][a-z0-9-]*$/i.test(scope)) throw new Error('Invalid document CSS scope.');
  if (!css.trim()) return '';
  const parsed = postcss.parse(css, { from: undefined });
  const root = postcss.root();
  const scopeName = scope.slice(1);
  function append(source: Container, target: Container, depth = 0) {
    if (depth > 6) return;
    for (const node of source.nodes || []) {
      if (node.type === 'atrule') {
        if (!['media', 'supports'].includes(node.name.toLowerCase()) || !node.nodes || !/^[a-z0-9\s:().<>=\-%,]+$/i.test(node.params)) continue;
        const rule = postcss.atRule({ name: node.name.toLowerCase(), params: node.params });
        append(node, rule, depth + 1); if (rule.nodes?.length) target.append(rule);
      } else if (node.type === 'rule') {
        const selectors = selectorParser().astSync(node.selector);
        selectors.walkTags(tag => { if (['html', 'body'].includes(tag.value.toLowerCase())) tag.replaceWith(selectorParser.className({ value: scopeName })); });
        // Earlier saved custom CSS can use this root alias; it is never an application DOM ID.
        selectors.walkIds(id => { if (id.value === 'write') id.replaceWith(selectorParser.className({ value: scopeName })); });
        selectors.walkClasses(name => { if (['ProseMirror', 'meki-document'].includes(name.value)) name.value = scopeName; });
        selectors.walkPseudos(pseudo => { if (pseudo.value === ':root') pseudo.replaceWith(selectorParser.className({ value: scopeName })); });
        const safeSelectors: string[] = [];
        selectors.each(selector => {
          const value = selector.toString().trim().replace(new RegExp(`(?:\\${scope}\\s+)+\\${scope}`, 'g'), scope);
          if (!value || /[{}@\\]|<\/style/i.test(value)) return;
          // Both subjects must be the document root or its descendants, even for sibling combinators and :has().
          safeSelectors.push(`${scope}${scope}:is(${value})`, `${scope}${scope} :is(${value})`);
        });
        if (!safeSelectors.length) continue;
        const rule = postcss.rule({ selector: safeSelectors.join(',') });
        for (const child of node.nodes || []) {
          if (child.type !== 'decl') continue;
          const property = child.prop.toLowerCase();
          if (!properties.has(property) && !/^--[a-z][a-z0-9-]*$/i.test(property)) continue;
          const value = child.value;
          if (/[\\<>\0\x01-\x08]/.test(value) || /(?:url|image|image-set|cross-fade|paint|element|expression|attr)\s*\(|@import|javascript\s*:/i.test(value)) continue;
          rule.append(postcss.decl({ prop: property, value, important: child.important }));
        }
        if (rule.nodes?.length) target.append(rule);
      }
    }
  }
  append(parsed, root);
  return root.toString();
}

export function writingFont(settings: Pick<Settings, 'font' | 'fontFamily'>): string {
  const fallback = settings.font === 'sans' ? "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" : "Georgia,'Songti SC','Noto Serif CJK SC',SimSun,serif";
  const family = (settings.fontFamily || '').trim();
  return family && /^[\p{L}\p{N} _.-]{1,128}$/u.test(family) ? `${JSON.stringify(family)},${fallback}` : fallback;
}

export const appearanceDefaults = { theme: 'paper', font: 'serif', fontSize: 18, lineWidth: 760, customCss: '', fontFamily: '' } as const;
type Appearance = Pick<Settings, 'theme' | 'font' | 'fontSize' | 'lineWidth' | 'customCss' | 'fontFamily'> & Partial<CodeOptions>;

/** Shared document appearance used by the editor, standalone HTML and printed PDF. */
export function writingAppearance(input: Partial<Appearance> = {}, options: { scope?: string; exporting?: boolean } = {}): string {
  const settings = { ...appearanceDefaults, ...input };
  const writingSize = Math.min(options.exporting ? 32 : 24, Math.max(options.exporting ? 12 : 14, settings.fontSize));
  const rootScope = options.scope || '.meki-document';
  const scope = `${rootScope}${rootScope}`;
  const colors = settings.theme === 'night' ? ['#202521', '#d9dfd5', '#a6b09e', '#aac49c', '#343d33', '#1a1f1c']
    : settings.theme === 'linen' ? ['#faf6ee', '#433f34', '#827760', '#816a40', '#e7e0d2', '#f1ecdf']
    : ['#ffffff', '#303a35', '#657267', '#416b5b', '#e8ebe5', '#f5f6f3'];
  const [background, text, soft, accent, border, side] = colors;
  let custom = '';
  try { custom = normalizeCustomCss(settings.customCss, rootScope); } catch { /* Invalid saved CSS must not prevent opening a document. */ }
  return `${scope}{--bg:${background};--text:${text};--soft:${soft};--accent:${accent};--border:${border};--side:${side};--body-font:${writingFont(settings)};--writing-size:${writingSize}px;--mono:'SFMono-Regular',Consolas,'Liberation Mono',monospace;--ui:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text);font-family:var(--body-font);font-size:var(--writing-size);line-height:1.95;letter-spacing:.015em;overflow-wrap:anywhere;}
${scope} :is(h1,h2,h3,h4,h5,h6){color:var(--text);font-family:inherit;line-height:1.5;font-weight:600;scroll-margin-top:30px;}
${scope} :is(h1,h2,h3,h4,h5,h6)[data-heading-number]::before{content:attr(data-heading-number) " ";font-variant-numeric:tabular-nums;}
${scope} h1{font-size:2.03em;margin:1.3em 0 .75em;letter-spacing:-.025em;}
${scope}>h1:nth-child(1 of :not(.ProseMirror-widget,.prosemirror-virtual-cursor)){margin-top:0;padding-top:0;}
${scope} h2{font-size:1.28em;margin:1.7em 0 .7em;letter-spacing:-.01em;}
${scope} h3{font-size:1.1em;margin:1.55em 0 .7em;}
${scope} :is(h4,h5,h6){font-size:1em;margin:1.4em 0 .65em;}
${scope} p{margin:0 0 1.05em;line-height:1.95;}
${scope} strong{font-weight:700;color:var(--text);}${scope} em{color:var(--soft);}
${scope} a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent);text-underline-offset:4px;}
${scope} blockquote{border-left:2px solid var(--accent);margin:1.5em 0;padding:.35em 0 .35em 1.3em;color:var(--soft);}
${scope} blockquote p{margin:.2em 0;font-style:italic;}
${scope} blockquote::before{content:none;}
${scope} :is(ul,ol){margin:.9em 0 1.4em;padding-left:1.5em;}
${scope} li{margin:.3em 0;padding-left:.15em;}${scope} li p{margin:.3em 0;}${scope} input[type=checkbox]{accent-color:var(--accent);}
${scope} code{font-family:var(--mono);font-size:.81em;font-weight:400;line-height:1.4286;display:inline-block;background:var(--side);color:var(--accent);border-radius:4px;padding:.17em .38em;}
${scope} pre{background:var(--side);border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;line-height:1.8;margin:calc(1.3 * var(--writing-size)) 0;padding:20px;overflow:auto;}
${scope} pre code{display:block;padding:0;background:none;color:var(--text);font-size:14px;line-height:1.8;}
${scope} table{border:1px solid var(--border);border-collapse:collapse;width:100%;font-family:var(--ui);font-size:.84em;margin:1.5em 0;}
${scope} :is(td,th){border:1px solid var(--border);padding:10px 14px;text-align:left;line-height:1.7;}${scope} :is(td,th) p{margin:0;line-height:1.7;}${scope} th{background:var(--side);font-weight:600;}
${scope} img{max-width:100%;height:auto;border-radius:5px;}${scope} hr{border:0;border-top:1px solid var(--border);margin:2.2em 0;padding:0;height:0;background:none;}
${scope} .meki-inline-math{display:inline-block;vertical-align:bottom;padding:0 4px;color:var(--accent);}
${custom}
${codeAppearance(input, scope)}
@media print{${scope}{print-color-adjust:exact;-webkit-print-color-adjust:exact;}${scope} :is(pre,blockquote,tr){break-inside:avoid;}${scope} :is(h1,h2,h3,h4,h5,h6){break-after:avoid;}}
`;
}

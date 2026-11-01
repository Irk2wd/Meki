import { ht, t } from '../electron/i18n.mjs';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { HTMLMathItem } from '@mathjax/src/js/handlers/html/HTMLMathItem.js';
import type { MathItem } from '@mathjax/src/js/core/MathItem.js';
import type { LiteElement } from '@mathjax/src/js/adaptors/lite/Element.js';
import type { LiteText } from '@mathjax/src/js/adaptors/lite/Text.js';
import type { LiteDocument } from '@mathjax/src/js/adaptors/lite/Document.js';
import type { AbstractTags } from '@mathjax/src/js/input/tex/Tags.js';
import type TexError from '@mathjax/src/js/input/tex/TexError.js';
import { SerializedMmlVisitor } from '@mathjax/src/js/core/MmlTree/SerializedMmlVisitor.js';
import { offlineMathFont } from './math-font.ts';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js';
import '@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js';

export type MathSettings = {
  mathNumbering?: 'none' | 'ams' | 'all';
  mathPhysics?: boolean;
};
export type MathExpression = { tex: string; display: boolean };
export type RenderedMath = { html: string; error?: string; mathml?: string; docxMathml?: string };
export type MathDocumentResult = {
  items: RenderedMath[];
  css: string;
  labels: Record<string, { tag: string; id: string }>;
};

type Item = MathItem<LiteElement, LiteText, LiteDocument>;
const adaptor = liteAdaptor({ fontSize: 16 });
RegisterHTMLHandler(adaptor);
const MAX_TEX_LENGTH = 64 * 1024;
const safeColor = /^(?:[a-z]+|#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|hsl)a?\([\d\s.,%+\/-]+\))$/i;
const wordMathNodes = new Set('math mrow inferredMrow TeXAtom mi mn mo mtext mspace mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd mstyle mfenced mmultiscripts mprescripts none text'.split(' '));
const mathmlVisitor = new SerializedMmlVisitor();

function exchangeMath(item: Item) {
  // Serialize the already-compiled tree so macros and forward references match the page.
  // IDs and navigation links belong to this renderer, not to the receiving application.
  const mathml = mathmlVisitor.visitTree(item.root).replace(/\s(?:data-[\w-]+|class|id|href)="[^"]*"/g, '');
  let compatible = true;
  item.root.walkTree(node => {
    if (!wordMathNodes.has(node.kind)) compatible = false;
    for (const name of ['color', 'mathcolor', 'background', 'mathbackground', 'style']) if (node.attributes?.getExplicit(name)) compatible = false;
  });
  for (const entity of mathml.matchAll(/&#(?:x([\da-f]+)|(\d+));/gi)) {
    const code = parseInt(entity[1] || entity[2], entity[1] ? 16 : 10);
    if ((code >= 0xE000 && code <= 0xF8FF) || code >= 0xF0000) compatible = false;
  }
  if (mathml.length > 2 * 1024 * 1024) return {};
  return { mathml, ...(compatible ? { docxMathml: mathml } : {}) };
}

function escapeHTML(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function errorResult(expression: MathExpression, message: string): RenderedMath {
  return {
    html: `<span class="meki-math meki-math-error" data-math-display="${expression.display}" role="math" title="${escapeHTML(message)}"><span class="meki-math-error-message">${ht("公式错误：{0}", escapeHTML(message))}</span><code>${escapeHTML(expression.tex)}</code></span>`,
    error: message,
  };
}

const errorCSS = '.meki-math-error{display:inline-flex;flex-direction:column;gap:.25em;max-width:100%;color:#a24437}.meki-math-error code{white-space:pre-wrap;overflow-wrap:anywhere}.meki-math-error-message{font:12px/1.5 sans-serif}.meki-math[data-math-display="true"]{display:block;max-width:100%;overflow-x:auto}.meki-math mjx-container[jax="SVG"]{max-width:100%}.meki-math mjx-container[jax="SVG"] a{fill:currentColor;stroke:currentColor}';

/** Render all expressions in document order, including forward references.
 * A fresh TeX input jax isolates numbering, labels and user macros per document.
 * SVG contains its glyph outlines and needs neither a font URL nor a script.
 */
export function renderMathDocument(expressions: readonly MathExpression[], settings: MathSettings = {}, idPrefix = 'meki-equation'): MathDocumentResult {
  if (!expressions.length) return { items: [], css: errorCSS, labels: {} };
  const prefix = /^[a-zA-Z][\w-]{0,48}$/.test(idPrefix) ? idPrefix : 'meki-equation';
  const numbering = ['none', 'ams', 'all'].includes(settings.mathNumbering || '') ? settings.mathNumbering! : 'none';
  const errors = new Map<Item, string>();
  const indexes = new Map<Item, number>();
  const tex = new TeX<LiteElement, LiteText, LiteDocument>({
    packages: ['base', 'ams', 'newcommand', 'configmacros', 'boldsymbol', 'color', 'cancel', 'mhchem', ...(settings.mathPhysics ? ['physics'] : [])],
    macros: { bm: ['\\boldsymbol{#1}', 1] },
    tags: numbering,
    maxBuffer: MAX_TEX_LENGTH,
    maxMacros: 1000,
    maxTemplateSubtitutions: 1000,
    formatError(jax: TeX<LiteElement, LiteText, LiteDocument>, error: TexError) {
      errors.set(jax.parseOptions.mathItem as Item, error.message);
      return jax.formatError(error);
    },
  });
  // Never install autoload, require, html, href or includegraphics extensions.
  const svg = new SVG<LiteElement, LiteText, LiteDocument>({ fontData: offlineMathFont, fontCache: 'none', exFactor: 0.5 });
  const document = mathjax.document('', { InputJax: tex, OutputJax: svg });
  const tags = tex.parseOptions.tags as AbstractTags;
  tags.allLabels = Object.create(null);
  tags.allIds = Object.create(null);
  const startEquation = tags.startEquation.bind(tags);
  tags.startEquation = item => {
    startEquation(item);
    tags.labels = Object.create(null);
    tags.ids = Object.create(null);
  };
  // The upstream tagformat extension registers a new global class on each use.
  // Override this instance instead, keeping IDs stable without retaining documents.
  Object.defineProperty(tags, 'formatId', { value: (id: string) => `${prefix}-${(indexes.get(tex.parseOptions.mathItem as Item) ?? 0) + 1}-${encodeURIComponent(id)}` });
  tags.formatUrl = id => `#${encodeURIComponent(id)}`;

  const items = expressions.map((expression, index) => {
    const tooLong = expression.tex.length > MAX_TEX_LENGTH;
    const item = new HTMLMathItem<LiteElement, LiteText, LiteDocument>(tooLong ? '' : expression.tex, tex, expression.display);
    item.start.node = adaptor.body(document.document);
    item.setMetrics(16, 8, 760, 1);
    indexes.set(item, index);
    if (tooLong) errors.set(item, t("公式超过 64 KiB，请拆分后再预览。"));
    document.math.push(item);
    return item;
  });

  // MathDocument.compile runs a second pass for unresolved forward references.
  document.compile();
  // color/cancel accept CSS color strings. Permit actual colors only: SVG paint
  // values such as url(...) could otherwise request an external resource.
  for (const item of items) item.root?.walkTree(node => {
    for (const name of ['color', 'mathcolor', 'background', 'mathbackground']) {
      const value = node.attributes.getExplicit(name);
      if (value && !safeColor.test(String(value).trim())) errors.set(item, t("公式颜色必须是颜色名称、十六进制或 RGB/HSL 值。"));
    }
    const style = node.attributes.getExplicit('style');
    if (style && /[\\@{}]|url\s*\(|(?:https?|data|file|javascript)\s*:|image\s*\(/i.test(String(style))) errors.set(item, t("公式不允许加载外部资源或插入任意样式。"));
    const borderColor = style && String(style).match(/^border:\s*2px solid\s+(.+)$/s);
    if (borderColor && !safeColor.test(borderColor[1].trim())) errors.set(item, t("公式边框必须使用普通颜色值。"));
  });
  document.typeset();
  const rendered = items.map((item, index) => {
    let error = errors.get(item) || item.inputData.error?.message || item.inputData.error || item.outputData.error?.message || item.outputData.error;
    item.root?.walkTree(node => {
      if (node.kind === 'merror') error ||= String(node.attributes.get('data-mjx-error') || node.attributes.get('title') || t("无法解析公式"));
      if (node.attributes.get('class') === 'MathJax_ref' && node.attributes.get('href') === '#') error ||= t("未找到引用的公式标签，或该公式没有编号。");
    });
    if (error || !item.typesetRoot) return errorResult(expressions[index], String(error || t("无法渲染公式")));
    const content = adaptor.outerHTML(item.typesetRoot);
    return { html: `<span class="meki-math" data-math-display="${expressions[index].display}" role="math" aria-label="${escapeHTML(expressions[index].tex)}">${content}</span>`, ...exchangeMath(item) };
  });
  const labels = Object.fromEntries(Object.entries(tags.allLabels).map(([key, label]) => [key, { tag: label.tag, id: label.id }]));
  return { items: rendered, css: adaptor.cssText(svg.styleSheet(document)) + '\n' + errorCSS, labels };
}

/** Isolated formula dialog preview; it cannot change the document's numbering. */
export function renderMath(tex: string, display = true, settings: MathSettings = {}) {
  const document = renderMathDocument([{ tex, display }], settings, 'meki-preview-equation');
  return { ...document.items[0], css: document.css };
}

import { t, ht } from '../electron/i18n.mjs';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { diagramBranchColors, diagramPalettes, diagramTheme, escapeDiagramText, safeDiagramStyleValue, validateDiagramSource, type DiagramTheme } from './diagram-policy.ts';

export interface RenderedDiagram { html: string; error?: string; }
export interface DiagramOptions { theme?: string; id: string; }
const fontFamily = 'system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const styleProperties = new Set('alignment-baseline background background-color baseline-shift border border-color border-width border-style color color-interpolation color-rendering dominant-baseline fill fill-opacity fill-rule filter font font-family font-size font-style font-variant font-weight height letter-spacing line-height marker-end marker-mid marker-start max-width min-width opacity overflow paint-order rx ry shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-overflow text-rendering transform transform-origin vertical-align visibility white-space width word-break word-spacing word-wrap'.split(' '));
let serial = 0;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<RenderedDiagram>>();

function cleanDeclarations(css: string) {
  const root = postcss.parse(css);
  root.walkAtRules(rule => { rule.remove(); });
  root.walkDecls(decl => { if (!styleProperties.has(decl.prop.toLowerCase()) || !safeDiagramStyleValue(decl.value)) decl.remove(); });
  return root;
}

function sanitizeSvg(markup: string, theme: DiagramTheme) {
  if (/<foreignObject\b/i.test(markup)) throw new Error(t("此图表包含 HTML 标签布局；目前仅支持 SVG 文本标签，请简化标签后重试。"));
  const fragment = DOMPurify.sanitize(markup, { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'], FORBID_TAGS: ['foreignObject', 'image', 'script', 'a', 'animate', 'animateMotion', 'animateTransform', 'set'], FORBID_ATTR: ['target'] });
  const svg = fragment.querySelector('svg');
  if (!svg) throw new Error(t("图表没有生成有效 SVG。"));
  const rootId = svg.id;
  const ids = new Map<string, string>();
  let nextId = 0;
  for (const node of svg.querySelectorAll('[id]')) { const next = `${rootId}-item-${nextId++}`; if (!ids.has(node.id)) ids.set(node.id, next); node.id = next; }
  const localReferences = (value: string) => value.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (match, _quote, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match);
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      const mapped = localReferences(attribute.value);
      if (mapped !== attribute.value) node.setAttribute(attribute.name, mapped);
      if (/href$/.test(attribute.name) && attribute.value.startsWith('#') && ids.has(attribute.value.slice(1))) node.setAttribute(attribute.name, `#${ids.get(attribute.value.slice(1))}`);
      if (/^aria-(?:labelledby|describedby)$/.test(attribute.name)) node.setAttribute(attribute.name, attribute.value.split(/\s+/).map(id => ids.get(id) || id).join(' '));
      if (attribute.name === 'style') {
        try { node.setAttribute('style', cleanDeclarations(attribute.value).toString()); } catch { node.removeAttribute('style'); }
      } else if (/href$/.test(attribute.name) && !/^#[\w:.-]+$/.test(attribute.value) || /url\s*\(/i.test(attribute.value) && !safeDiagramStyleValue(attribute.value)) node.removeAttribute(attribute.name);
    }
  }
  for (const style of svg.querySelectorAll('style')) {
    try {
      const rules = cleanDeclarations(localReferences(style.textContent || ''));
      rules.walkRules(rule => {
        try {
          rule.selector = selectorParser(selectors => {
            selectors.walkIds(node => { if (ids.has(node.value)) node.value = ids.get(node.value)!; });
            selectors.each(selector => {
              // Every generated selector is bounded by the root SVG, including user classDef rules.
              if (selector.nodes[0]?.type === 'id' && selector.nodes[0].value === rootId) {
                const combinator = selector.nodes.find(node => node.type === 'combinator');
                if (combinator && combinator.value.trim() && combinator.value.trim() !== '>') throw new Error('Unbounded SVG selector');
              } else {
                selector.prepend(selectorParser.combinator({ value: ' ' })); selector.prepend(selectorParser.id({ value: rootId }));
              }
            });
          }).processSync(rule.selector);
        } catch { rule.remove(); }
      });
      style.textContent = rules.toString();
    } catch { style.remove(); }
  }
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.backgroundColor = diagramPalettes[theme].background;
  const naturalWidth = svg.viewBox.baseVal.width;
  svg.style.maxWidth = Number.isFinite(naturalWidth) && naturalWidth > 0 ? `min(100%, ${naturalWidth}px)` : '100%';
  svg.style.height = 'auto';
  return svg.outerHTML;
}

function errorResult(source: string, message: string): RenderedDiagram {
  const error = message.slice(0, 1200);
  return { error, html: `<div class="meki-diagram meki-diagram-error" data-diagram-state="error" role="status"><strong>${ht("图表未能渲染")}</strong><div>${escapeDiagramText(error)}</div><pre>${escapeDiagramText(source)}</pre></div>` };
}

/** One local Mermaid instance, serialized initialization/rendering, no callbacks or remote icon packs. */
export function renderDiagram(source: string, options: DiagramOptions): Promise<RenderedDiagram> {
  const problem = validateDiagramSource(source);
  if (problem) return Promise.resolve(errorResult(source, problem));
  const theme = diagramTheme(options.theme);
  const key = JSON.stringify([theme, options.id, source]);
  const cached = cache.get(key); if (cached) return cached;
  const job = queue.then(async () => {
    const palette = diagramPalettes[theme];
    const branchColors = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [[`cScale${index}`, diagramBranchColors[theme][index % 3]], [`cScaleLabel${index}`, palette.foreground], [`cScaleInv${index}`, palette.border]]).flat());
    const id = `meki-diagram-${++serial}-${options.id.replace(/[^a-z0-9_-]/gi, '-')}`;
    const host = document.createElement('div');
    host.className = 'meki-diagram-measure'; host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: '1200px', visibility: 'hidden', pointerEvents: 'none' });
    document.body.append(host);
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, theme: 'base', look: 'classic', fontFamily, maxTextSize: 64_000, maxEdges: 500,
        secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'suppressErrorRendering'],
        themeVariables: { ...branchColors, git0: palette.primary, gitBranchLabel0: palette.foreground, darkMode: theme === 'night', background: palette.background, primaryColor: palette.primary, primaryTextColor: palette.foreground, primaryBorderColor: palette.border, secondaryColor: palette.secondary, secondaryTextColor: palette.foreground, secondaryBorderColor: palette.border, tertiaryColor: palette.secondary, tertiaryTextColor: palette.foreground, tertiaryBorderColor: palette.border, lineColor: palette.accent, textColor: palette.foreground, mainBkg: palette.primary, nodeTextColor: palette.foreground, actorTextColor: palette.foreground, actorBkg: palette.primary, actorBorder: palette.border, signalColor: palette.accent, signalTextColor: palette.foreground, labelBoxBkgColor: palette.primary, labelTextColor: palette.foreground, noteBkgColor: palette.secondary, noteTextColor: palette.foreground, noteBorderColor: palette.border, clusterBkg: palette.secondary, clusterBorder: palette.border, edgeLabelBackground: palette.background, fontFamily },
      });
      const rendered = await mermaid.render(id, source, host);
      const svg = sanitizeSvg(rendered.svg, theme);
      return { html: `<div class="meki-diagram" data-diagram-state="ready" data-diagram-theme="${theme}">${svg}</div>` };
    } catch (error) { return errorResult(source, error instanceof Error ? error.message : String(error)); }
    finally { host.remove(); }
  });
  queue = job.catch(() => undefined);
  cache.set(key, job);
  if (cache.size > 96) cache.delete(cache.keys().next().value!);
  return job;
}

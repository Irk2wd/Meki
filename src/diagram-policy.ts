import { t } from '../electron/i18n.mjs';
export type DiagramTheme = 'paper' | 'linen' | 'night';
export const diagramLimit = 64_000;

export const diagramPalettes = {
  paper: { background: '#ffffff', foreground: '#283d33', primary: '#e7efe9', secondary: '#f3f5f1', border: '#72957f', accent: '#35674d' },
  linen: { background: '#faf6ee', foreground: '#493f30', primary: '#ece3d1', secondary: '#f4ecdd', border: '#a18a65', accent: '#786142' },
  night: { background: '#202521', foreground: '#e0e7df', primary: '#35473b', secondary: '#2b352e', border: '#86a68d', accent: '#b8d1b6' },
} satisfies Record<DiagramTheme, Record<string, string>>;
export const diagramBranchColors = { paper: ['#dce9df', '#dde6ee', '#eee4d5'], linen: ['#dfd5bd', '#d5dfcf', '#e7d8c9'], night: ['#43644e', '#4a596e', '#695744'] };

export function diagramTheme(theme?: string): DiagramTheme { return theme === 'night' || theme === 'linen' ? theme : 'paper'; }
export function escapeDiagramText(text: string) { return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

/** Inspect escapes too: resource values must be rejected before Mermaid creates its measurement DOM. */
export function normalizedDiagramValue(value: string) {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\(?:\r\n|[\n\r\f])/g, '').replace(/\\([\da-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff))).replace(/\\([^\da-f])/gi, '$1')
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_, hex: string, dec: string) => String.fromCodePoint(Math.min(parseInt(hex || dec, hex ? 16 : 10), 0x10ffff)))
    .replace(/&(?:colon|tab|newline);/gi, token => token.toLowerCase() === '&colon;' ? ':' : ' ');
}

export function validateDiagramSource(source: string): string | undefined {
  if (!source.trim()) return t("请输入 Mermaid 图表源码。");
  if (source.length > diagramLimit || source.split('\n').length > 1500) return t("图表过大，请拆分为较小的图表（每幅最多 64,000 字符、1,500 行）。");
  const value = normalizedDiagramValue(source);
  if (/^\s*---(?:\r?\n|$)/.test(value) || /%%\s*\{/.test(value)) return t("图表内的配置指令暂不支持；请使用应用的外观设置。");
  if (/(?:^|[\r\n;])\s*(?:click|link|links)\s/mi.test(value)) return t("图表中的链接和点击回调不受支持。");
  if (/<\s*\/?\s*(?!br\s*\/?\s*>)[a-z][^>]*>/i.test(value)) return t("图表标签不执行 HTML；请使用纯文本（可用 <br> 换行）。");
  if (/(?:^|[,{\s])(?:img|image)\s*:/i.test(value) || /\b(?:url|image-set|expression|paint)\s*\(|@(?:import|font-face)\b|(?:javascript|vbscript)\s*:/i.test(value)) return t("图表不能加载外部资源或执行脚本。");
  return undefined;
}

/** SVG paints may reference a marker/gradient in this SVG, never another file. */
export function safeDiagramStyleValue(value: string) {
  const normalized = normalizedDiagramValue(value);
  if (/@|[<>]|(?:javascript|vbscript)\s*:|\b(?:image-set|expression|paint|element)\s*\(/i.test(normalized)) return false;
  return !/url\s*\(/i.test(normalized.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, ''));
}

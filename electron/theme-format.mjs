import { t } from './i18n.mjs';
import kraft from './themes/kraft.meki-theme.json' with { type: 'json' };

export const MAX_THEME_PACKAGE_BYTES = 256 * 1024;
export const MAX_THEME_LIBRARY_BYTES = 1536 * 1024;
const maxInstalledThemes = 24;

const bases = {
  paper: { bg: '#ffffff', side: '#f5f6f3', surface: '#ffffff', text: '#303a35', muted: '#91998f', soft: '#657267', border: '#e8ebe5', accent: '#416b5b', 'accent-soft': '#e7eee6', hover: '#edf1e9', selection: '#cfdfd3', 'logo-ink': '#fffdf4' },
  linen: { bg: '#faf6ee', side: '#f1ecdf', surface: '#fffaf0', text: '#433f34', muted: '#a29a88', soft: '#827760', border: '#e7e0d2', accent: '#816a40', 'accent-soft': '#ece2cc', hover: '#eee7d9', selection: '#e4d5b6', 'logo-ink': '#faf5e9' },
  night: { bg: '#202521', side: '#1a1f1c', surface: '#2b322c', text: '#d9dfd5', muted: '#788376', soft: '#a6b09e', border: '#343d33', accent: '#aac49c', 'accent-soft': '#364532', hover: '#2b342b', selection: '#445a3c', 'logo-ink': '#202a1e' },
};

const builtin = (id, name, base, appearance = {}) => ({ version: 1, id, name, base, ...appearance });
export const builtinThemes = [
  builtin('paper', '纸白', 'paper'),
  builtin('linen', '亚麻', 'linen'),
  builtin('night', '夜墨', 'night'),
  builtin('manuscript', '手稿纸', 'linen', {
    palette: { bg: '#f8efd9', side: '#eee2c8', surface: '#fcf5e5', text: '#3e3326', muted: '#806a55', soft: '#69553f', border: '#dbcaab', accent: '#8b492f', 'accent-soft': '#ecd9bd', hover: '#f0e3ca', selection: '#e9c9a4', 'logo-ink': '#fcf5e5' },
    background: {
      image: 'radial-gradient(ellipse at 22% 15%, #fffaf0a8, transparent 72%), repeating-linear-gradient(17deg, #744a1805 0 1px, transparent 1px 4px), repeating-linear-gradient(103deg, transparent 0 3px, #633b1509 3px 4px, transparent 4px 7px)',
      size: '100% 100%, auto, auto',
      repeat: 'no-repeat, repeat, repeat',
    },
    styles: {
      heading: { 'font-family': "Georgia, 'Songti SC', 'Noto Serif CJK SC', SimSun, serif", 'font-weight': '600' },
      h1: { 'font-size': '2.18em', 'padding-bottom': '.34em', 'border-bottom': '3px double var(--accent)', 'letter-spacing': '.015em' },
      h2: { color: 'var(--accent)', 'letter-spacing': '.04em' },
      paragraph: { 'line-height': '2.06' },
      quote: { 'border-left': '3px double var(--accent)', 'background-color': '#8b492f0c', 'padding-right': '1.1em' },
      tableHead: { 'border-bottom': '3px double var(--border)' },
      rule: { 'border-top': '3px double var(--border)' },
    },
  }),
  kraft,
  builtin('graph', '方格笔记', 'paper', {
    palette: { bg: '#f4f8f8', side: '#e8f0f2', surface: '#fbfdfd', text: '#223842', muted: '#617480', soft: '#455e6a', border: '#ccdce2', accent: '#24627d', 'accent-soft': '#d9eaf0', hover: '#e6eff2', selection: '#c6dfe9', 'logo-ink': '#f3fbff' },
    background: {
      image: 'linear-gradient(#44758d16 1px, transparent 1px), linear-gradient(90deg, #44758d16 1px, transparent 1px)',
      size: '22px 22px',
    },
    styles: {
      heading: { 'font-family': 'system-ui, sans-serif', 'font-weight': '650' },
      h1: { 'border-left': '4px solid var(--accent)', 'padding-left': '.48em' },
      h2: { 'border-bottom': '1px dashed var(--border)', 'padding-bottom': '.24em' },
      quote: { 'background-color': '#d9eaf0b3', 'border-radius': '0 5px 5px 0' },
      codeBlock: { 'border-style': 'dashed', 'border-radius': '4px' },
      tableHead: { 'background-color': 'var(--accent-soft)' },
      rule: { 'border-top-style': 'dashed' },
    },
  }),
  builtin('cyber', '赛博', 'night', {
    palette: { bg: '#101721', side: '#141e2c', surface: '#1a2736', text: '#e0eaf5', muted: '#8397ae', soft: '#a5b8ce', border: '#2d4358', accent: '#7ce6db', 'accent-soft': '#193b43', hover: '#203447', selection: '#254c65', 'logo-ink': '#101721' },
    background: {
      image: 'radial-gradient(ellipse at 80% 0%, #306a8266, transparent 62%), linear-gradient(#84f4e410 1px, transparent 1px), linear-gradient(90deg, #84f4e410 1px, transparent 1px)',
      size: '100% 100%, 30px 30px, 30px 30px',
    },
    styles: {
      heading: { 'font-family': "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", 'letter-spacing': '.025em' },
      h1: { color: 'var(--accent)', 'text-shadow': '0 0 24px #6fe9d636', 'border-bottom': '1px solid var(--border)', 'padding-bottom': '.28em' },
      h2: { 'border-left': '2px solid var(--accent)', 'padding-left': '.56em' },
      quote: { 'background-color': '#78e9d710', 'border-radius': '0 6px 6px 0' },
      codeBlock: { 'border-radius': '3px', 'box-shadow': 'inset 0 1px #7ce6db24' },
      tableHead: { 'font-family': 'monospace', 'background-color': 'var(--accent-soft)' },
      rule: { 'border-top-style': 'dashed' },
    },
  }),
];
const builtinIds = new Set(builtinThemes.map(theme => theme.id));
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{1,47}$/.test(id);
export const hasTheme = (id, library = []) => validId(id) && (builtinIds.has(id) || library.some(theme => theme.id === id));

export function resolveTheme(id, library = []) {
  const theme = builtinThemes.find(item => item.id === id) || library.find(item => item.id === id) || builtinThemes[0];
  return { ...theme, palette: { ...bases[theme.base], ...theme.palette } };
}

// Each key is a stable public Markdown role. Only the app chooses its selectors.
export const themeRoles = {
  document: '', heading: ':is(h1,h2,h3,h4,h5,h6)', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  paragraph: 'p', link: 'a', quote: 'blockquote', quoteText: 'blockquote p', list: ':is(ul,ol)', listItem: 'li',
  code: ':not(pre) > code', codeBlock: ':is(pre,.milkdown-code-block:not(:has(.meki-math,.meki-block-diagram)))',
  table: 'table', tableHead: 'th', tableCell: 'td', image: 'img', rule: 'hr', emphasis: 'em', strong: 'strong',
};
const styleProperties = new Set(`color background-color font-family font-size font-style font-weight font-variant-numeric
  line-height letter-spacing word-spacing text-align text-decoration text-decoration-color text-decoration-style
  text-decoration-thickness text-underline-offset text-shadow margin margin-top margin-right margin-bottom margin-left
  margin-block margin-inline padding padding-top padding-right padding-bottom padding-left padding-block padding-inline
  border border-width border-style border-color border-top border-right border-bottom border-left border-top-style
  border-radius box-shadow list-style-type list-style-position`.split(/\s+/));
const documentProperties = new Set(['color', 'background-color', 'line-height', 'letter-spacing', 'word-spacing', 'text-align']);
const colorFunctions = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'oklab', 'oklch', 'color-mix'];
const gradients = ['linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient'];
const valueFunctions = new Set([...colorFunctions, ...gradients, 'calc', 'min', 'max', 'clamp']);
const paletteVariable = /var\(\s*--([a-z-]+)\s*\)/g;

const invalid = field => new TypeError(t("主题字段无效或不受支持：{0}", field));
function object(value, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(field);
  return value;
}
function fields(value, allowed, field) {
  return Object.entries(object(value, field)).map(([key, entry]) => {
    if (!Object.hasOwn(allowed, key)) throw invalid(`${field}.${key.slice(0, 48)}`);
    return [key, entry];
  });
}

// Values occupy one declaration. Disallow CSS escapes, comments, rule delimiters and resource functions.
function cssValue(value, field, max = 512) {
  if (typeof value !== 'string' || value.length > max || !/^[\p{L}\p{M}\p{N} #,.%+\-*/()'"_\t]+$/u.test(value) || /\/\*|\*\//.test(value)) throw invalid(field);
  const clean = value.trim();
  const check = clean.replace(paletteVariable, (_, key) => {
    if (!Object.hasOwn(bases.paper, key)) throw invalid(field);
    return '#ffffff';
  });
  if (!check) throw invalid(field);
  let level = 0, quote = '';
  for (const match of check.matchAll(/([\p{L}\p{M}\p{N}_-]+)\(|[()'"]/gu)) {
    const token = match[0];
    if (quote) {
      if (token === quote) quote = '';
    } else if (token === '"' || token === "'") {
      quote = token;
    } else if (token === ')') {
      if (--level < 0) throw invalid(field);
    } else if (!valueFunctions.has(match[1]?.toLowerCase()) || ++level > 8) {
      throw invalid(field);
    }
  }
  if (quote || level !== 0) throw invalid(field);
  return clean;
}

export const pngDataPrefix = 'data:image/png;base64,';
function backgroundImage(value) {
  const field = 'background.image';
  if (typeof value === 'string' && value.startsWith(pngDataPrefix)) {
    const encoded = value.slice(pngDataPrefix.length);
    if (encoded.length > 4 * Math.ceil(128 * 1024 / 3) || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid(field);
    let png;
    try { png = atob(encoded); } catch { throw invalid(field); }
    if (png.length > 128 * 1024 || png.length < 45 || !png.startsWith('\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR')) throw invalid(field);
    const bytes = Uint8Array.from(png, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const width = view.getUint32(16), height = view.getUint32(20);
    if (width < 1 || height < 1 || width > 1024 || height > 1024) throw invalid(field);
    let imageData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), type = png.slice(offset + 4, offset + 8);
      offset += size + 12;
      if (offset > bytes.length || type === 'acTL') throw invalid(field);
      if (type === 'IDAT') imageData = true;
      if (type === 'IEND' && size === 0 && imageData && offset === bytes.length) return value;
    }
    throw invalid(field);
  }
  const css = cssValue(value, field, 2048);
  if (!gradients.some(gradient => css.toLowerCase().startsWith(`${gradient}(`))) throw invalid(field);
  return css;
}

/** Canonicalize data before persistence. No paths or executable theme code enter the library. */
export function validateThemePackage(input) {
  fields(input, { version: 1, id: 1, name: 1, base: 1, palette: 1, background: 1, styles: 1 }, 'theme');
  if (input.version !== 1) throw new TypeError(t("此主题格式版本不受支持。"));
  if (!validId(input.id) || builtinIds.has(input.id)) throw invalid('id');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(input.name)) throw invalid('name');
  if (typeof input.base !== 'string' || !Object.hasOwn(bases, input.base)) throw invalid('base');
  const theme = { version: 1, id: input.id, name: input.name.trim(), base: input.base };
  if (Object.hasOwn(input, 'palette')) theme.palette = Object.fromEntries(fields(input.palette, bases.paper, 'palette').map(([key, value]) => {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw invalid(`palette.${key}`);
    return [key, value];
  }));
  if (Object.hasOwn(input, 'background')) {
    const background = fields(input.background, { image: 1, size: 1, repeat: 1, position: 1 }, 'background');
    if (!Object.hasOwn(input.background, 'image')) throw invalid('background.image');
    theme.background = Object.fromEntries(background.map(([key, value]) => [key, key === 'image' ? backgroundImage(value) : cssValue(value, `background.${key}`)]));
  }
  if (Object.hasOwn(input, 'styles')) theme.styles = Object.fromEntries(fields(input.styles, themeRoles, 'styles').map(([role, rule]) => {
    const declarations = Object.entries(object(rule, `styles.${role}`)).map(([property, value]) => {
      if (!(role === 'document' ? documentProperties : styleProperties).has(property)) throw invalid(`styles.${role}.${property.slice(0, 48)}`);
      return [property, cssValue(value, `styles.${role}.${property}`)];
    });
    return [role, Object.fromEntries(declarations)];
  }));
  return theme;
}

export function validateThemeLibrary(input, restoring = false) {
  if (!Array.isArray(input)) {
    if (restoring) return [];
    throw invalid('installedThemes');
  }
  if (input.length > maxInstalledThemes && !restoring) throw new Error(t("已达到本地主题库容量上限，请先移除一个主题。"));
  const library = [], ids = new Set();
  let bytes = 0;
  for (const entry of input.slice(0, maxInstalledThemes)) {
    try {
      const theme = validateThemePackage(entry);
      const size = new TextEncoder().encode(JSON.stringify({ settings: { installedThemes: [theme] } }, null, 2)).length;
      if (bytes + size > MAX_THEME_LIBRARY_BYTES) throw new Error(t("已达到本地主题库容量上限，请先移除一个主题。"));
      if (ids.has(theme.id)) throw invalid('id');
      ids.add(theme.id);
      library.push(theme);
      bytes += size;
    } catch (error) {
      if (!restoring) throw error;
    }
  }
  return library;
}

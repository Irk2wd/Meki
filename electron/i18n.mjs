import english from './locales/en.json' with { type: 'json' };

// Chinese source messages are stable keys. Only application-owned literals call
// these helpers; document text, paths, names, and release notes are opaque values.
export const locales = Object.freeze(['zh-CN', 'en']);
// The installed bootstrap and an activated update can load separate module copies.
// Share the effective language within each process, never across worker boundaries.
const localeKey = Symbol.for('moye.ui-locale');
export function isLocale(value) { return locales.includes(value); }
export function setLocale(value) { globalThis[localeKey] = isLocale(value) ? value : 'zh-CN'; }
export function getLocale() { return globalThis[localeKey] || 'zh-CN'; }
const message = key => getLocale() === 'en' && Object.hasOwn(english, key) ? english[key] : key;
const interpolate = (text, values) => text.replace(/\{(\d+)\}/g, (token, index) => Number(index) < values.length ? String(values[Number(index)]) : token);
export function t(key, ...values) { return interpolate(message(key), values); }

// Escape literal HTML text/attributes. Parameters retain their existing contract:
// callers pass escaped text or trusted markup (e.g. an icon), never raw user HTML.
// Preserve the source's existing character entities, such as &#123;filename&#125;.
const escapeHTML = text => text.replace(/&(?!(?:#(?:\d+|x[\da-f]+)|amp|lt|gt|quot|apos|nbsp);)|[<>"']/gi,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function ht(key, ...values) { return interpolate(escapeHTML(message(key)), values); }

export const DOCUMENT_SCHEME = 'mekir:';
export const RESEARCH_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export function researchLinkId(href) {
  if (typeof href !== 'string' || !href.startsWith(DOCUMENT_SCHEME) || href.length > 8192 || /[\x00-\x20<>]/.test(href)) return null;
  const id = href.slice(DOCUMENT_SCHEME.length).split('#', 1)[0];
  return RESEARCH_ID.test(id) ? id : null;
}

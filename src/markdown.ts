/** Keep YAML verbatim; rich editing and exports operate only on the body. */
export function separateMetadata(text: string) {
  const match = text.match(/^(?:\uFEFF)?---[ \t]*\r?\n(?:[^\n]*\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  return { prefix: match?.[0] || '', body: match ? text.slice(match[0].length) : text };
}

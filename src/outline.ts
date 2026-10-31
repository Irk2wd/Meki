import { parseMarkdown } from './markdown-render.ts';
import { separateMetadata } from './markdown.ts';
import { headingIds, headingText } from './markdown-extensions.ts';
import type { RootContent } from 'mdast';
export interface OutlineEntry { level: number; text: string; offset: number; id: string; parent: number; children: boolean }
export function buildOutline(markdown: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [], prefix = separateMetadata(markdown).prefix.length;
  const walk = (node: RootContent) => {
    if (node.type === 'heading') entries.push({ level: node.depth, text: headingText(node), offset: prefix + (node.position?.start.offset || 0), id: '', parent: -1, children: false });
    if ('children' in node) node.children.forEach(child => walk(child as RootContent));
  };
  parseMarkdown(markdown).children.forEach(walk);
  const ids = headingIds(entries.map(entry => entry.text)), stack: number[] = [];
  entries.forEach((entry, index) => {
    while (stack.length && entries[stack.at(-1)!].level >= entry.level) stack.pop();
    entry.id = ids[index]; entry.parent = stack.at(-1) ?? -1;
    if (entry.parent >= 0) entries[entry.parent].children = true;
    stack.push(index);
  });
  return entries;
}
export function visibleOutline(entries: OutlineEntry[], collapsed: Set<string>) {
  return entries.map(entry => { let parent = entry.parent; while (parent >= 0) { if (collapsed.has(entries[parent].id)) return false; parent = entries[parent].parent; } return true; });
}

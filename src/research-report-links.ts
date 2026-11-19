import type { Root, RootContent } from 'mdast';
import { researchLinkId } from '../electron/research-links.mjs';
import { researchReportFormat } from '../electron/research-report-format.mjs';
import type { ResearchDocument, ResearchReference } from '../shared/research';
import { parseMarkdown } from './markdown-render';

export function reportReferences({ record, body }: ResearchDocument, indexed: ResearchReference[]): ResearchReference[] {
  const reports = new Map(indexed.filter(file => file.sourceId && researchReportFormat(file.relativePath)).map(file => [file.id, file]));
  if (!reports.size) return [];

  const ids = new Set([...(record.evidence ?? []), ...(record.sources ?? []), ...(record.run?.evidence ?? [])]);
  const definitions = new Map<string, string>();
  const links: Array<{ url: string } | { identifier: string }> = [];
  function visit(node: Root | RootContent) {
    if (node.type === 'link' || node.type === 'linkReference') links.push(node);
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if ('children' in node) node.children.forEach(child => visit(child as RootContent));
  }
  visit(parseMarkdown(body));
  for (const link of links) {
    const id = researchLinkId('url' in link ? link.url : definitions.get(link.identifier));
    if (id) ids.add(id);
  }
  return [...ids].flatMap(id => {
    const report = reports.get(id);
    return report ? [report] : [];
  });
}

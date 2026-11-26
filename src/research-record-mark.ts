import type { ResearchRecord, ResearchType } from '../shared/research';
import { icon } from './icons';

type RecordKind = ResearchType['kind'] | 'file' | 'warning';
const glyphs: Record<RecordKind, string> = {
  entry: 'flask', summary: 'bookmark', comparison: 'image', event: 'calendar', file: 'page', warning: 'warning',
};

export function recordKind(type?: ResearchType, record?: ResearchRecord): RecordKind {
  if (record?.comparison) return 'comparison';
  if (record?.coverage) return 'summary';
  return type?.kind ?? (record ? 'entry' : 'file');
}

export function recordMark(kind: RecordKind, size: number, glyph = glyphs[kind]) {
  return `<span class="research-kind-mark" data-record-kind="${kind}" aria-hidden="true">${icon(glyph, size)}</span>`;
}

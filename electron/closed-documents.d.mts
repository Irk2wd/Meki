import type { DocumentFile } from '../shared/moye';
export interface ClosedDocument { document: DocumentFile; savedContent: string; dirty: boolean; mode: 'visual' | 'source'; scroll: number; sourceScroll: number; }
export const CLOSED_LIMITS: { readonly count: number; readonly bytes: number };
export class ClosedDocuments { readonly length: number; readonly bytes: number; peek(): ClosedDocument | undefined; pop(): ClosedDocument | undefined; push(entries: ClosedDocument[]): void; }

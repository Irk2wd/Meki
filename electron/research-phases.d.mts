import type { ResearchEntry, ResearchPhase, ResearchRange, ResearchRecord } from '../shared/research';

export function sortEntries(a: Pick<ResearchEntry, 'record'>, b: Pick<ResearchEntry, 'record'>): number;
export function overlaps(a: ResearchRange, b: ResearchRange): boolean;
export function projectToday(timeZone: string): string;
export function phaseSpan(phase: ResearchPhase, today: string): ResearchRange;
export function summaryCoversPhase(record: ResearchRecord, phase: ResearchPhase, phases: ResearchPhase[], today: string): boolean;

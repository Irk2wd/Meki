import type { ResearchEntry, ResearchFilter, ResearchPhase, ResearchRange, ResearchRecord } from '../shared/research';

type DatedEntry = Pick<ResearchEntry, 'record' | 'trials'>;
export function activityDates(entry: DatedEntry): string[];
export const monthTerms: RegExp;
export function monthFilter(filter?: Pick<ResearchFilter, 'month' | 'query'>): ((date: string) => boolean) | undefined;
export function latestActivity(entry: DatedEntry, from?: string, to?: string, accepts?: (date: string) => boolean): string;
export function sortEntries(a: DatedEntry, b: DatedEntry): number;
export function overlaps(a: ResearchRange, b: ResearchRange): boolean;
export function projectToday(timeZone: string): string;
export function phaseSpan(phase: ResearchPhase, today: string): ResearchRange;
export function summaryCoversPhase(record: ResearchRecord, phase: ResearchPhase, phases: ResearchPhase[], today: string): boolean;

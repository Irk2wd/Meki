import type { ResearchComparison } from '../shared/research';

export const comparisonLimits: Readonly<{ rows: number; columns: number }>;
export const evidenceImageExtensions: readonly string[];
export function evidenceImageMime(file: string): string | undefined;
export function comparisonImages(comparison?: ResearchComparison): string[];

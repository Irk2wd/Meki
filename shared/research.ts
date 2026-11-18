export type ResearchValue = string | number | boolean;

export interface ResearchRange { start: string; end: string }
export interface ResearchPhase extends ResearchRange { id: string; title: string }
export interface ResearchField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'choice';
  description?: string;
  required?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: ResearchValue;
}

export interface ResearchType {
  id: string;
  label: string;
  kind: 'entry' | 'summary';
  description?: string;
  fields: ResearchField[];
  template: string;
}

export interface ResearchView {
  id: string;
  label: string;
  layout: 'timeline' | 'journal';
  order: 'newest' | 'oldest';
  typeIds?: string[];
  phaseIds?: string[];
  fieldIds?: string[];
}

export interface ResearchProject {
  version: 1;
  id: string;
  title: string;
  description?: string;
  timezone: string;
  instructions?: string[];
  phases: ResearchPhase[];
  recordTypes: ResearchType[];
  views: ResearchView[];
  defaultView: string;
}

export interface ResearchRecord {
  id: string;
  type: string;
  title: string;
  date: string;
  phaseId?: string | null;
  coverage?: ResearchRange | null;
  sources?: string[];
  fields: Record<string, ResearchValue>;
}

export interface ResearchEntry {
  record: ResearchRecord;
  revision: string;
  relativePath: string;
  issues: string[];
}

export interface ResearchSnapshot {
  root: string;
  project: ResearchProject;
  revision: string;
  records: ResearchEntry[];
  problems: Array<{ file: string; message: string }>;
}

export interface ResearchBatch {
  ifProjectRevision?: string;
  records: Array<Partial<Omit<ResearchRecord, 'fields'>> & {
    id: string;
    ifRevision?: string | null;
    body?: string;
    fields?: Record<string, ResearchValue | null>;
  }>;
}

export interface ResearchWriteResult {
  projectRevision: string;
  records: Array<{ id: string; revision: string; relativePath: string; changed: boolean }>;
}

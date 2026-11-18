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

export interface ResearchSource { id: string; label: string }
export interface BoundResearchSource extends ResearchSource { directory?: string; available: boolean }

export interface ResearchFilter {
  query?: string;
  month?: string;
  fields?: Array<{ field: string; value: string }>;
}

export interface SavedResearchFilter extends ResearchFilter { id: string; label: string }

export type ResearchRelationKind = 'retest' | 'replaces' | 'compares' | 'paper-adopted' | 'paper-version';
export interface ResearchRelation { kind: ResearchRelationKind; target: string; note?: string }

export interface ResearchRun {
  id: string;
  sourceId: string;
  directory: string;
  category: string;
  title?: string;
  date?: string;
  status?: string;
  context: Record<string, string>;
  missing: string[];
  evidence: string[];
  reportRevision?: string;
  manifestRevision?: string;
  importedBodyRevision?: string;
}

export interface ResearchEvidenceFile {
  id: string;
  title: string;
  source: string;
  relativePath: string;
  kind: 'text' | 'image' | 'file';
  content?: string;
  mime?: string;
}

export interface ResearchImportRun {
  runId: string;
  title: string;
  directory: string;
  change: 'new' | 'changed' | 'unchanged' | 'blocked';
  missing: string[];
  error?: string;
}

export interface ResearchImportPreview {
  sourceId: string;
  token: string;
  runs: ResearchImportRun[];
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
  evidenceSources?: ResearchSource[];
  savedFilters?: SavedResearchFilter[];
}

export interface ResearchRecord {
  id: string;
  type: string;
  title: string;
  date: string;
  phaseId?: string | null;
  coverage?: ResearchRange | null;
  sources?: string[];
  evidence?: string[];
  relations?: ResearchRelation[];
  run?: ResearchRun;
  fields: Record<string, ResearchValue>;
}

export interface ResearchEntry {
  record: ResearchRecord;
  revision: string;
  relativePath: string;
  issues: string[];
}

export interface ResearchReference {
  id: string;
  title: string;
  relativePath: string;
  date?: string;
  sourceId?: string;
}

export interface RecentResearchProject { root: string; title: string }

export interface ResearchSnapshot {
  root: string;
  project: ResearchProject;
  revision: string;
  manifestFile: string;
  records: ResearchEntry[];
  documents: ResearchReference[];
  problems: Array<{ file: string; message: string }>;
  evidenceSources?: BoundResearchSource[];
  matchingIds?: string[];
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

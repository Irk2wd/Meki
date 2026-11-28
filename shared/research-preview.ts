import type { ResearchGoal, ResearchGoalMode, ResearchRange, ResearchTier, ResearchType, ResearchView } from './research';

export interface PreviewPhase {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string | null;
  goals: ResearchGoal[];
  records: number;
  latest?: string;
  finding?: { date: string; text: string };
  days: { date: string; records: number; trials: number }[];
}
export interface PreviewItem {
  type?: string;
  phaseId?: string;
  tier?: ResearchTier;
  days?: string[];
  sources?: string[];
  id: string;
  phases: string[];
  kind: 'entry' | 'summary' | 'event' | 'comparison';
  title: string;
  label: string;
  icon?: string;
  date: string;
  coverage?: ResearchRange;
  text: string;
  body?: string;
  figure?: { columns: string[]; rows: { label: string; images: (string | null)[] }[] };
}
export interface PreviewSnapshot {
  format: string;
  asOf: string;
  project: { id: string; title: string; description: string; start?: string; phaseGoals: ResearchGoalMode;
    timezone?: string; types?: Pick<ResearchType, 'id' | 'label' | 'kind' | 'icon'>[];
    views?: Omit<ResearchView, 'fieldIds'>[]; defaultView?: string };
  phases: PreviewPhase[];
  items: PreviewItem[];
  mediaTypes?: Record<string, 'jpeg'>;
}
export interface PreviewState {
  pointer: { projectId: string; revision: string; publishedAt: string };
  snapshot: PreviewSnapshot;
}
export interface PreviewLogin { url: string; username: string; password?: string }
export interface PreviewConnection extends Omit<PreviewLogin, 'password'> {
  id: string; role: 'reader' | 'publisher'; projectId: string; title: string; publishedAt: string;
  auto?: boolean; pinned?: string[]; error: string;
}
export interface RemotePreviewAPI {
  previewPublisher(root: string): Promise<PreviewConnection | null>;
  previewPublish(root: string, input: PreviewLogin & {auto: boolean; pinned: string[]}): Promise<PreviewConnection>;
  previewPause(root: string): Promise<void>;
  previewSubscriptions(): Promise<PreviewConnection[]>;
  previewSubscribe(input: PreviewLogin, id?: string): Promise<PreviewConnection>;
  previewCached(id: string): Promise<PreviewState | null>;
  previewRefresh(id: string): Promise<PreviewState>;
  previewImage(id: string, hash: string): Promise<string | null>;
  previewUnsubscribe(id: string): Promise<void>;
}

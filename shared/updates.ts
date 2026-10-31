export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  notes: string;
  releaseUrl: string | null;
  repository: string;
  kind: 'payload' | 'installer' | null;
  downloaded: number;
  total: number;
  message: string;
  credential: 'none' | 'cli' | 'token';
  canRemember: boolean;
}
export type UpdateCredentials = { kind: 'none' | 'cli' } | { kind: 'token'; token: string; remember: boolean };

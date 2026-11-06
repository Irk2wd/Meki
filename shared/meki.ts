import type { ExportRequest, ExportTools, ImportedDocument, DiagramSaveRequest } from './export';
import type { UpdateState } from './updates';
export interface DocumentFile {
  path: string | null;
  name: string;
  content: string;
  revision: string | null;
}
export interface Draft extends DocumentFile { updatedAt: number }
export type ShortcutChange = { command: string; value: string | null } | { resetAll: true };
export interface ReopenedDocument { kind: 'disk' | 'buffer' | 'copy' | 'existing'; document?: DocumentFile; message?: string; }
export interface Settings {
  locale: 'zh-CN' | 'en';
  shortcuts?: Record<string, string | null>;
  theme: 'paper' | 'linen' | 'night';
  font: 'serif' | 'sans';
  fontSize: number;
  lineWidth: number;
  unlimitedWidth: boolean;
  focus: boolean;
  sidebar: boolean;
  customCss: string;
  fontFamily: string;
  mathNumbering: 'none' | 'ams' | 'all';
  mathPhysics: boolean;
  typewriter: boolean;
  paragraphFocus: boolean;
  spellcheck: boolean;
  typingAutoPair: 'default' | 'on' | 'off';
  typingMarkdownPairs: boolean;
  typingSmartQuotes: boolean;
  typingSmartDashes: boolean;
  autoSave: boolean;
  autoSaveInterval: number;
  autoSaveOnBlur: boolean;
  autoSnapshot: boolean;
  snapshotInterval: number;
  reopenSession: boolean;
  codeLineNumbers: boolean;
  headingNumbering: boolean;
  codeWrap: boolean;
  codeIndentSize: number;
  codeUseTabs: boolean;
  codeTabSize: number;
  codeAutoIndent: boolean;
  codeLanguageMode: 'plain' | 'default' | 'last';
  codeDefaultLanguage: string;
  codeLastLanguage: string;
  picgoPort: number;
  imageAutoUpload: boolean;
  imageDirectoryBase: 'document' | 'workspace';
  imageDirectory: string;
}
export type SavePause = 'external' | 'history' | 'recovered' | 'attachments' | 'error' | null;
export interface SessionDocument extends DocumentFile { id: string; dirty: boolean; mode: 'visual' | 'source'; paused: SavePause }
export interface DocumentSession { documents: SessionDocument[]; activeId: string | null; layout?: import('../electron/pane-layout.mjs').PaneLayout }
export interface RestoredSession extends DocumentSession { recovered: boolean }
export interface DocumentVersion { id: string; createdAt: number; size: number; revision: string }
export interface SnapshotTarget { path: string | null; tabId: string }
export interface DocumentSnapshot extends SnapshotTarget {
  id: string; name: string; label: string; kind: 'manual' | 'auto' | 'restore'; createdAt: number; size: number; revision: string;
}
export type AutomaticSaveResult = { status: 'saved'; document: DocumentFile } | { status: 'paused'; reason: string };
export interface ImportedTheme { name: string; css: string }
export interface ImageInput { name: string; bytes: Uint8Array }
export interface AttachmentPlan { id: string; target: string; count: number; reused: number; bytes: number; remote: number }
export interface AttachmentMapping { source: string; relativePath: string }
export interface ImageUploadPlan { id: string; count: number; bytes: number; remote: number; names: string[] }
export interface FileEntry { path: string; name: string; relativePath: string }
export interface WorkspaceEntry extends FileEntry { parentPath: string; kind: 'file' | 'directory'; modifiedAt: number; size: number }
export interface Workspace { root: string; entries: FileEntry[]; tree?: WorkspaceEntry[]; truncated?: boolean }
export type WorkspaceAction = 'create-file' | 'create-folder' | 'rename' | 'copy' | 'move' | 'trash';
export interface WorkspaceRequest { action: WorkspaceAction; path: string; name?: string; destination?: string }
export interface WorkspaceResult { action: WorkspaceAction; previousPath: string | null; path: string | null; workspace: Workspace; warning?: string }
export interface SearchMatch extends FileEntry { line: number; column: number; text: string }
export interface WorkspaceSearch { matches: SearchMatch[]; scanned: number; skipped: number; truncated: boolean }
export interface DocumentStatus { state: 'unchanged' | 'changed' | 'missing'; revision: string | null }
export interface RecentFile { path: string; name: string }
export interface RecentFolder extends RecentFile { pinned: boolean; lastOpened: number }
export interface RecentFolderChange { action: 'pin' | 'unpin' | 'remove' | 'clear'; path?: string }
export interface BootState {
  locale: Settings['locale'];
  windowId?: string;
  transferred?: boolean;
  platform: string;
  version: string;
  settings: Settings;
  recovery: Draft | null;
  initialDoc?: DocumentFile | null;
  recentFiles: RecentFile[];
  recentFolders: RecentFolder[];
  workspace: Workspace | null;
  session?: RestoredSession | null;
}
export interface MekiAPI {
  updateState(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateState>;
  setAutomaticUpdates(enabled: boolean): Promise<UpdateState>;
  dismissUpdateNotification(version: string): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<UpdateState>;
  applyUpdate(): Promise<void>;
  onUpdate(callback: (state: UpdateState) => void): () => void;
  boot(): Promise<BootState>;
  newWindow(): Promise<string>;
  detachDocument(tabId: string): Promise<boolean>;
  tileWindows(): Promise<void>;
  releaseDocument(path: string): Promise<void>;
  cancelClose(): Promise<void>;
  openDocument(path?: string): Promise<DocumentFile | null>;
  reopenClosedDocument(input: { path: string; revision: string | null; dirty: boolean }): Promise<ReopenedDocument>;
  updateShortcut(input: ShortcutChange): Promise<Settings>;
  shortcutCapture(active: boolean): Promise<void>;
  saveDocument(doc: DocumentFile & { saveAs?: boolean; tabId?: string; otherPaths?: string[] }): Promise<DocumentFile | null>;
  autoSaveDocument(doc: DocumentFile & { tabId: string }): Promise<AutomaticSaveResult>;
  saveSession(session: DocumentSession, forClose?: boolean): Promise<void>;
  listVersions(path: string): Promise<DocumentVersion[]>;
  readVersion(path: string, id: string): Promise<{ content: string }>;
  clearVersions(path: string): Promise<void>;
  createSnapshot(input: DocumentFile & { tabId: string; kind: DocumentSnapshot['kind']; label?: string }): Promise<DocumentSnapshot>;
  listSnapshots(target?: SnapshotTarget): Promise<DocumentSnapshot[]>;
  readSnapshot(id: string): Promise<{ snapshot: DocumentSnapshot; content: string }>;
  deleteSnapshot(id: string): Promise<boolean>;
  chooseFolder(): Promise<Workspace | null>;
  listRecentFolders(): Promise<RecentFolder[]>;
  openRecentFolder(path: string): Promise<Workspace>;
  changeRecentFolders(input: RecentFolderChange): Promise<RecentFolder[]>;
  refreshWorkspace(): Promise<Workspace | null>;
  workspaceOperation(input: WorkspaceRequest): Promise<WorkspaceResult | null>;
  searchWorkspace(query: string, caseSensitive?: boolean): Promise<WorkspaceSearch>;
  workspacePathAction(action: 'reveal' | 'copy-path', path: string): Promise<void>;
  resolveDocumentLink(href: string, documentPath: string): Promise<{ path: string; anchor: string }>;
  checkDocument(path: string, revision: string | null): Promise<DocumentStatus>;
  saveDraft(draft: Draft | null): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  importTheme(): Promise<ImportedTheme | null>;
  confirmDiscard(name: string): Promise<'save' | 'discard' | 'cancel'>;
  exportFile(input: ExportRequest): Promise<import('./export').ExportResult | null>;
  listExportPresets(): Promise<import('./export').ExportPresetCatalog>;
  saveExportPreset(input: { id?: string; name: string; options: import('./export').ExportOptions }): Promise<import('./export').ExportPreset>;
  deleteExportPreset(id: string): Promise<boolean>;
  chooseExportReference(): Promise<import('./export').ExportReference | null>;
  deleteExportReference(id: string): Promise<boolean>;
  exportTools(): Promise<ExportTools>;
  choosePandoc(): Promise<ExportTools>;
  importDocument(): Promise<ImportedDocument | null>;
  saveDiagram(input: DiagramSaveRequest): Promise<string | null>;
  assetUrl(source: string, documentPath: string | null): Promise<string>;
  saveAttachment(input: { bytes: Uint8Array; name: string; documentPath: string | null }): Promise<string>;
  chooseImages(): Promise<ImageInput[] | null>;
  saveAttachments(input: { images: ImageInput[]; documentPath: string }): Promise<string[]>;
  prepareAttachments(input: { documentPath: string; revision: string; sources: string[]; destination?: { base: 'document' | 'workspace'; directory: string }; name?: string; download?: boolean }): Promise<AttachmentPlan>;
  cancelImageDownload(): Promise<void>;
  commitAttachments(id: string): Promise<AttachmentMapping[]>;
  finishAttachments(id: string, keep: boolean): Promise<void>;
  checkImageHost(): Promise<string>;
  prepareImageUpload(input: { documentPath: string; revision: string; sources: string[] }): Promise<ImageUploadPlan>;
  uploadPreparedImages(id: string): Promise<Array<{ source: string; url: string }>>;
  uploadImages(images: ImageInput[]): Promise<string[]>;
  cancelImageUpload(): Promise<void>;
  abandonImageUpload(): Promise<void>;
  setDocumentState(input: { name: string; path: string | null; dirty: boolean }): Promise<void>;
  allowClose(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  onCommand(callback: (command: string, payload?: unknown) => void): () => void;
}
declare global { interface Window { meki: MekiAPI } }

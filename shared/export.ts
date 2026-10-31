export type ExportKind = 'html' | 'plain-html' | 'pdf' | 'png' | 'docx' | 'epub';
export interface PdfOptions { pageSize: 'A4' | 'Letter' | 'A5'; landscape: boolean; margin: number; pageNumbers: boolean; header: boolean; pageBreakBeforeH1?: boolean; }
export interface ExportOptions { kind: ExportKind; pdf?: PdfOptions; pngWidth?: number; pngScale?: number; theme?: 'current' | 'paper' | 'linen' | 'night'; fontSize?: number | null; referenceId?: string | null; }
export interface ExportPreset { id: string; name: string; options: ExportOptions; updatedAt: number; }
export interface ExportReference { id: string; name: string; size: number; sha256: string; createdAt: number; }
export interface ExportPresetCatalog { presets: ExportPreset[]; templates: ExportReference[]; }
export interface ExportRequest extends ExportOptions { html: string; suggestedName: string; }
export interface ExportResult { path: string; math?: { editable: number; fallback: number }; }
export interface ExportTools { available: boolean; version?: string; path?: string; message: string; }
export interface ImportedDocument { name: string; content: string; warnings: string[]; }
export interface DiagramSaveRequest { kind: 'svg' | 'png' | 'clipboard'; svg?: string; png?: Uint8Array; }

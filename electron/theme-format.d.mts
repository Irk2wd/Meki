export type ThemeBase = 'paper' | 'linen' | 'night';
type PaletteToken = 'bg' | 'side' | 'surface' | 'text' | 'muted' | 'soft' | 'border' | 'accent' | 'accent-soft' | 'hover' | 'selection' | 'logo-ink';
type ThemeRole = 'document' | 'heading' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'paragraph' | 'link' | 'quote' | 'quoteText' | 'list' | 'listItem' | 'code' | 'codeBlock' | 'table' | 'tableHead' | 'tableCell' | 'image' | 'rule' | 'emphasis' | 'strong';
export interface ThemeManifest {
  version: 1;
  id: string;
  name: string;
  base: ThemeBase;
  palette?: Partial<Record<PaletteToken, string>>;
  background?: { image: string; size?: string; repeat?: string; position?: string };
  styles?: Partial<Record<ThemeRole, Record<string, string>>>;
}
export type ResolvedTheme = Omit<ThemeManifest, 'palette'> & { palette: Record<PaletteToken, string> };
export const MAX_THEME_PACKAGE_BYTES: number;
export const MAX_THEME_LIBRARY_BYTES: number;
export const builtinThemes: readonly ThemeManifest[];
export const themeRoles: Record<ThemeRole, string>;
export const pngDataPrefix: string;
export function hasTheme(id: unknown, library?: readonly ThemeManifest[]): boolean;
export function resolveTheme(id?: string, library?: readonly ThemeManifest[]): ResolvedTheme;
export function validateThemePackage(input: unknown): ThemeManifest;
export function validateThemeLibrary(input: unknown, restoring?: boolean): ThemeManifest[];

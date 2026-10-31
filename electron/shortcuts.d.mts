export type ShortcutBindings = Record<string, string | null>;
export interface ShortcutEntry { id: string; label: string; normal: string | null; mac: string | null }
export const shortcutCatalog: readonly ShortcutEntry[];
export const shortcutIds: Set<string>;
export function defaultBinding(id: string, platform: string): string | null;
export function bindings(overrides?: ShortcutBindings, platform?: string): ShortcutBindings;
export function normalizeBinding(value: unknown): string | null;
export function reservedBinding(value: string | null, platform: string): boolean;
export function validateBindings(input: unknown, platform?: string): ShortcutBindings;
export function eventBinding(event: KeyboardEvent | Record<string, unknown>, platform?: string): string | null;
export function commandFor(event: KeyboardEvent | Record<string, unknown>, overrides: ShortcutBindings | undefined, platform: string): string | null;
export function accelerator(binding: string | null, platform?: string): string | undefined;
export function shortcutLabel(binding: string | null, platform: string): string;

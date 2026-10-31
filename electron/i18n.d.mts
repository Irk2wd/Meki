export type Locale = 'zh-CN' | 'en';
export const locales: readonly Locale[];
export function isLocale(value: unknown): value is Locale;
export function setLocale(value: unknown): void;
export function getLocale(): Locale;
export function t(key: string, ...values: unknown[]): string;
/** Parameters must be escaped text or trusted markup, matching the caller's HTML context. */
export function ht(key: string, ...values: unknown[]): string;

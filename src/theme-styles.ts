import { pngDataPrefix, themeRoles, type ResolvedTheme } from '../electron/theme-format.mjs';

export function cssDeclarations(declarations: Record<string, string>): string {
  return Object.entries(declarations).map(([name, value]) => `${name}:${value};`).join('');
}

export function themeBackground(theme: ResolvedTheme) {
  const { image = 'none', size = 'auto', repeat = 'repeat', position = '0 0' } = theme.background ?? {};
  return {
    image: image.startsWith(pngDataPrefix) ? `url("${image}")` : image,
    size, repeat, position,
  };
}

export function themePalette(theme: ResolvedTheme): Record<string, string> {
  return Object.fromEntries(Object.entries(theme.palette).map(([name, value]) => [`--${name}`, value]));
}

export function themeVariables(theme: ResolvedTheme): Record<string, string> {
  return {
    ...themePalette(theme),
    ...Object.fromEntries(Object.entries(themeBackground(theme)).map(([name, value]) => [`--theme-${name}`, value])),
  };
}

export function themeDocumentCss(theme: ResolvedTheme, scope: string): string {
  return (Object.keys(themeRoles) as Array<keyof typeof themeRoles>).map(role => {
    const rule = theme.styles?.[role];
    if (!rule) return '';
    const selector = themeRoles[role];
    return `${scope}${selector ? ` ${selector}` : ''}{${cssDeclarations(rule)}}`;
  }).join('\n');
}

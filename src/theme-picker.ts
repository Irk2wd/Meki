import { t } from '../electron/i18n.mjs';
import { builtinThemes, resolveTheme, type ResolvedTheme } from '../electron/theme-format.mjs';
import type { Settings } from '../shared/meki';
import { themeVariables } from './theme-styles';
import './paper-margins.css';

function builtinLabel(id: string): string {
  switch (id) {
    case 'linen': return t("亚麻");
    case 'night': return t("夜墨");
    case 'manuscript': return t("手稿纸");
    case 'kraft': return t("牛皮纸");
    case 'graph': return t("方格笔记");
    case 'cyber': return t("赛博");
    default: return t("纸白");
  }
}

// The preview uses the same canvas and headline styles as the document.
function preview(theme: ResolvedTheme, name: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.theme = theme.id;
  button.setAttribute('aria-label', t("{0}主题", name));
  button.title = name;
  const sample = document.createElement('span');
  sample.className = 'theme-sample';
  sample.toggleAttribute('data-theme-background', Boolean(theme.background));
  sample.setAttribute('aria-hidden', 'true');
  for (const [name, value] of Object.entries(themeVariables(theme))) sample.style.setProperty(name, value);
  const headline = document.createElement('span');
  headline.textContent = 'Aa';
  for (const property of ['font-family', 'font-weight', 'font-style', 'letter-spacing', 'text-shadow', 'color']) {
    const value = theme.styles?.h1?.[property] ?? theme.styles?.heading?.[property];
    if (value) headline.style.setProperty(property, value);
  }
  sample.append(headline);
  const label = document.createElement('span');
  label.className = 'theme-label';
  label.textContent = name;
  button.append(sample, label);
  return button;
}

export class ThemePicker {
  private library?: Settings['installedThemes'];
  private active?: string;

  constructor(private choices: HTMLElement, private remove: HTMLButtonElement) {}

  apply({ theme: id, installedThemes }: Settings) {
    const changed = this.active === undefined || installedThemes !== this.library;
    if (!changed && this.active === id) return;
    const theme = resolveTheme(id, installedThemes);
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.dataset.themeBase = theme.base;
    root.toggleAttribute('data-theme-background', Boolean(theme.background));
    root.toggleAttribute('data-paper-margins', theme.background?.placement === 'margins');
    for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);

    if (changed) {
      this.library = installedThemes;
      const previous = (document.activeElement as HTMLButtonElement | null)?.dataset.theme;
      const buttons = [
        ...builtinThemes.map(item => preview(resolveTheme(item.id), builtinLabel(item.id))),
        ...(installedThemes ?? []).map(item => preview(resolveTheme(item.id, installedThemes), item.name)),
      ];
      this.choices.replaceChildren(...buttons);
      if (previous) buttons.find(button => button.dataset.theme === previous)?.focus({ preventScroll: true });
    }
    for (const button of this.choices.querySelectorAll('button')) {
      const selected = button.dataset.theme === theme.id;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    this.remove.hidden = !installedThemes?.some(item => item.id === theme.id);
    this.active = id;
  }
}

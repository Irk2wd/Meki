import { ht, t } from '../electron/i18n.mjs';
import { renderMath, type MathSettings } from './math-engine';

/** Explicit formula copying never changes document contents or the normal copy command. */
export function installMathCopyActions(settings: () => MathSettings, notify: (message: string, error?: boolean) => void, blocked: () => boolean) {
  const menu = document.createElement('div'); menu.id = 'math-copy-menu'; menu.className = 'math-copy-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  menu.innerHTML = `<button type="button" role="menuitem" data-math-copy="tex">${ht("复制 LaTeX")}</button><button type="button" role="menuitem" data-math-copy="mathml">${ht("复制 MathML（用于 Word）")}</button>`;
  document.body.append(menu);
  let selected: { tex: string; mathml: string } | null = null;
  const copy = async (kind: string, expression: { tex: string; mathml: string }) => {
    try {
      const value = kind === 'tex' ? expression.tex : expression.mathml;
      if (!value) throw new Error(kind === 'tex' ? t("请先输入公式。") : t("此公式存在错误，请修正后再复制 MathML。"));
      await window.moye.writeClipboardText(value);
      notify(kind === 'tex' ? t("已复制 LaTeX") : t("已复制 MathML；在 Word 中使用“仅保留文本”粘贴为公式。"));
    } catch (error) { notify(String(error).replace(/^Error: /, ''), true); }
  };
  document.addEventListener('contextmenu', event => {
    const formula = (event.target as Element).closest<HTMLElement>('.ProseMirror [data-math-tex]');
    if (!formula || blocked() || document.querySelector('dialog[open]')) return;
    event.preventDefault(); event.stopPropagation();
    selected = { tex: formula.dataset.mathTex || '', mathml: formula.dataset.mathml || '' };
    menu.querySelector<HTMLButtonElement>('[data-math-copy="mathml"]')!.disabled = !selected.mathml;
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button')!.focus();
  }, true);
  menu.addEventListener('click', event => {
    const kind = (event.target as Element).closest<HTMLElement>('[data-math-copy]')?.dataset.mathCopy;
    if (!kind || !selected) return; menu.hidden = true; void copy(kind, selected);
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) menu.hidden = true; });
  document.addEventListener('scroll', () => { menu.hidden = true; }, true);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); menu.hidden = true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  });
  const dialog = document.querySelector('#math-dialog')!;
  const controls = document.createElement('div'); controls.className = 'math-copy-controls';
  controls.innerHTML = `<button type="button" data-preview-copy="tex">${ht("复制 LaTeX")}</button><button type="button" data-preview-copy="mathml">${ht("复制 MathML")}</button>`;
  dialog.querySelector('#math-preview')!.after(controls);
  controls.addEventListener('click', event => {
    const kind = (event.target as Element).closest<HTMLElement>('[data-preview-copy]')?.dataset.previewCopy;
    if (!kind) return;
    const tex = dialog.querySelector<HTMLTextAreaElement>('#math-input')!.value.trim();
    const display = dialog.querySelector<HTMLSelectElement>('#math-kind')!.value === 'block';
    void copy(kind, { tex, mathml: tex ? renderMath(tex, display, settings()).mathml || '' : '' });
  });
}

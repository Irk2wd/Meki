import { t } from '../electron/i18n.mjs';
import type { DocumentFile } from '../shared/meki';
import { revealFileLabel } from './file-location';
import './document-menu.css';

interface Hooks {
  current(): DocumentFile;
  document(id: string): DocumentFile | undefined;
  platform(): string;
  blocked(): boolean;
  notify(message: string, error?: boolean): void;
}

/** File actions retain the clicked document without changing the active editor. */
export class DocumentMenu {
  private menu = document.createElement('div');
  private path: string | null = null;
  private anchor?: HTMLElement;
  constructor(private hooks: Hooks) {
    this.menu.id = 'document-menu'; this.menu.className = 'document-menu'; this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', t("文稿位置"));
    document.body.append(this.menu);
    document.addEventListener('contextmenu', event => {
      const anchor = (event.target as Element).closest<HTMLElement>('.document-tab,#document-name');
      if (!anchor) return;
      event.preventDefault();
      const file = this.target(anchor);
      if (file && !hooks.blocked()) this.show(file, anchor, event.clientX, event.clientY);
    });
    document.addEventListener('keydown', event => {
      if (!this.menu.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); return; }
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      const anchor = (event.target as Element).closest<HTMLElement>('.document-tab,#document-name');
      if (!anchor) return;
      const file = this.target(anchor); if (!file || hooks.blocked()) return;
      event.preventDefault(); const rect = anchor.getBoundingClientRect();
      this.show(file, anchor, rect.left, rect.bottom);
    });
    this.menu.addEventListener('keydown', event => {
      const buttons = [...this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length].focus();
    });
    this.menu.addEventListener('click', event => {
      const action = (event.target as Element).closest<HTMLButtonElement>('button')?.dataset.documentAction;
      if (!this.path || !action || hooks.blocked()) return;
      const file = this.path; this.close(true);
      void window.meki.documentPathAction(action as 'reveal' | 'copy-path', file).then(() => {
        if (action === 'copy-path') hooks.notify(t("已复制完整路径"));
      }).catch(error => hooks.notify(String(error), true));
    });
    document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target as Node)) this.close(); }, true);
    document.addEventListener('scroll', () => this.close(), true);
    window.addEventListener('resize', () => this.close());
    window.addEventListener('blur', () => this.close());
  }
  private target(anchor: HTMLElement) {
    const id = anchor.querySelector<HTMLElement>('[data-document-id]')?.dataset.documentId;
    return anchor.id === 'document-name' ? this.hooks.current() : id ? this.hooks.document(id) : undefined;
  }
  private show(file: DocumentFile, anchor: HTMLElement, x: number, y: number) {
    this.anchor = anchor; this.path = file.path;
    this.menu.replaceChildren();
    if (!file.path) {
      const note = document.createElement('div'); note.className = 'document-menu-note'; note.textContent = t("请先保存文稿，再打开所在文件夹。"); this.menu.append(note);
    }
    for (const [action, label] of [['reveal', revealFileLabel(this.hooks.platform())], ['copy-path', t("复制完整路径")]]) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.dataset.documentAction = action; button.textContent = label; button.disabled = !file.path; this.menu.append(button);
    }
    this.menu.hidden = false;
    this.menu.style.left = `${Math.max(8, Math.min(x, innerWidth - this.menu.offsetWidth - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(y, innerHeight - this.menu.offsetHeight - 8))}px`;
    this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  private close(restoreFocus = false) {
    this.menu.hidden = true; this.path = null;
    if (restoreFocus && this.anchor?.isConnected) (this.anchor.querySelector<HTMLElement>('[role=tab]') || this.anchor).focus({ preventScroll: true });
  }
}

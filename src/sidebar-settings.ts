import { ht } from '../electron/i18n.mjs';
import { icon } from './icons';
import './sidebar-settings.css';

interface Hooks {
  blocked(): boolean;
  closeOthers(): void;
  open(action: string): Promise<void>;
}

export class SidebarSettings {
  private button = document.querySelector<HTMLButtonElement>('#sidebar-settings-button')!;
  private menu = document.createElement('div');
  constructor(private hooks: Hooks) {
    this.menu.id = 'sidebar-settings-menu'; this.menu.className = 'popover sidebar-settings-menu'; this.menu.hidden = true;
    this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-labelledby', this.button.id);
    this.menu.innerHTML = `<div class="sidebar-settings-heading">${ht("设置")}</div>
      <button type="button" role="menuitem" tabindex="-1" data-sidebar-setting="style">${icon('style', 16)}<span>${ht("外观与排版")}</span></button>
      <button type="button" role="menuitem" tabindex="-1" data-sidebar-setting="lifecycle-settings">${icon('save', 16)}<span>${ht("文稿与保存")}</span></button>
      <button type="button" role="menuitem" tabindex="-1" data-sidebar-setting="shortcut-settings">${icon('keyboard', 16)}<span>${ht("自定义快捷键…")}</span></button>
      <div role="separator"></div>
      <button type="button" role="menuitem" tabindex="-1" data-sidebar-setting="image-hosting">${icon('image', 16)}<span>${ht("图床")}</span></button>
      <button type="button" role="menuitem" tabindex="-1" data-sidebar-setting="organize-attachments">${icon('folder', 16)}<span>${ht("整理图片附件…")}</span></button>`;
    document.body.append(this.menu);
    this.button.addEventListener('click', event => { event.stopPropagation(); this.toggle(); });
    this.button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); this.show(event.key === 'ArrowUp');
      }
    });
    this.menu.addEventListener('click', event => {
      event.stopPropagation();
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sidebar-setting]')?.dataset.sidebarSetting;
      if (!action || this.hooks.blocked()) return;
      this.close(true);
      void this.hooks.open(action).then(() => {
        const panel = action === 'style' ? '#style-panel' : action === 'lifecycle-settings' ? '#lifecycle-settings' : null;
        if (panel) document.querySelector<HTMLElement>(`${panel} input, ${panel} select, ${panel} button`)?.focus();
      });
    });
    this.menu.addEventListener('keydown', event => {
      const items = [...this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === 'ArrowDown') next = (index + 1) % items.length;
      else if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'Tab') { this.close(true); return; }
      else return;
      event.preventDefault(); event.stopPropagation(); items[next].focus();
    });
    document.addEventListener('pointerdown', event => {
      if (!this.menu.contains(event.target as Node) && !this.button.contains(event.target as Node)) this.close();
    }, true);
    document.addEventListener('keydown', event => {
      if (!this.menu.hidden && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); this.close(true);
      }
    }, true);
    window.addEventListener('resize', () => { if (!this.menu.hidden) this.position(); });
  }
  close(restoreFocus = false) {
    this.menu.hidden = true; this.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.button.focus();
  }
  private toggle() { if (this.menu.hidden) this.show(); else this.close(); }
  private show(last = false) {
    if (this.hooks.blocked()) return;
    this.hooks.closeOthers(); this.menu.hidden = false; this.button.setAttribute('aria-expanded', 'true'); this.position();
    const items = this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[last ? items.length - 1 : 0].focus();
  }
  private position() {
    const button = this.button.getBoundingClientRect(), menu = this.menu.getBoundingClientRect();
    if (!button.width || !button.height) { this.close(); return; }
    this.menu.style.left = `${Math.max(8, Math.min(button.left, innerWidth - menu.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, button.top - menu.height - 8)}px`;
  }
}

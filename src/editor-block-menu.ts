import { computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { t } from '../electron/i18n.mjs';
import { icon } from './icons';

export interface BlockAction {
  id: string; label: string; icon?: string; disabled?: boolean; danger?: boolean;
  children?: BlockAction[]; run?: () => void | Promise<void>;
}

export class BlockMenu {
  readonly element = document.createElement('section');
  private submenu: HTMLElement | null = null;
  private parentButton: HTMLButtonElement | null = null;
  private hoverTimer = 0;
  private closed = false;
  private input = document.createElement('input');
  private list = document.createElement('div');
  private footer = document.createElement('div');
  constructor(private anchor: HTMLElement, title: string, summary: string, private actions: BlockAction[], private onClose: (focus: boolean) => void) {
    this.element.className = 'meki-block-menu';
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-label', t('块操作'));
    this.input.type = 'search'; this.input.placeholder = t('搜索块操作…'); this.input.setAttribute('aria-label', t('搜索块操作'));
    this.input.autocomplete = 'off'; this.input.spellcheck = false;
    const heading = document.createElement('div'); heading.className = 'meki-block-menu-title'; heading.textContent = title;
    this.list.className = 'meki-block-menu-items'; this.list.setAttribute('role', 'menu');
    this.footer.className = 'meki-block-menu-footer'; this.footer.textContent = summary; this.footer.setAttribute('role', 'status');
    this.element.append(this.input, heading, this.list, this.footer); document.body.append(this.element);
    this.render();
    void this.position(this.element, anchor, 'bottom-start').then(() => { if (!this.closed) this.input.focus({ preventScroll: true }); });
    this.input.addEventListener('input', () => { this.closeSubmenu(); this.render(); });
    this.element.addEventListener('keydown', this.keydown);
    document.addEventListener('pointerdown', this.outside, true);
    window.addEventListener('resize', this.dismiss);
  }
  contains(target: Node | null) { return Boolean(target && (this.element.contains(target) || this.submenu?.contains(target))); }
  private dismiss = () => this.close(false);
  private outside = (event: PointerEvent) => { if (!this.contains(event.target as Node) && !this.anchor.contains(event.target as Node)) this.close(false); };
  close(focus = false) {
    if (this.closed) return;
    this.closed = true; this.closeSubmenu(); this.element.remove();
    document.removeEventListener('pointerdown', this.outside, true); window.removeEventListener('resize', this.dismiss);
    this.onClose(focus);
  }
  status(message: string) { if (!this.closed) this.footer.textContent = message; }
  private position(element: HTMLElement, anchor: HTMLElement, placement: 'bottom-start' | 'right-start') {
    return computePosition(anchor, element, { strategy: 'fixed', placement,
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply: ({ availableHeight, elements }) => {
        elements.floating.style.maxHeight = `${Math.max(100, availableHeight)}px`;
      } })],
    }).then(({ x, y }) => { if (element.isConnected) Object.assign(element.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' }); });
  }
  private render() {
    this.list.replaceChildren();
    const query = this.input.value.trim().toLocaleLowerCase();
    const flatten = (actions: BlockAction[], prefix = ''): BlockAction[] => actions.flatMap(action => action.children
      ? flatten(action.children, `${action.label} · `) : [{ ...action, label: prefix + action.label }]);
    const actions = query ? flatten(this.actions).filter(action => action.label.toLocaleLowerCase().includes(query)) : this.actions;
    for (const action of actions) this.list.append(this.button(action));
    if (!actions.length) { const empty = document.createElement('p'); empty.className = 'meki-block-menu-empty'; empty.textContent = t('没有匹配的操作'); this.list.append(empty); }
  }
  private button(action: BlockAction) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.blockAction = action.id;
    button.setAttribute('role', 'menuitem'); button.disabled = Boolean(action.disabled);
    if (action.danger) button.classList.add('danger');
    const symbol = document.createElement('span'); symbol.className = 'meki-block-menu-icon'; symbol.innerHTML = icon(action.icon || 'page', 17);
    const label = document.createElement('span'); label.textContent = action.label; button.append(symbol, label);
    if (action.children) {
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('span'); arrow.className = 'meki-block-menu-arrow'; arrow.innerHTML = icon('chevron', 14); button.append(arrow);
      button.addEventListener('pointerenter', () => { window.clearTimeout(this.hoverTimer); this.hoverTimer = window.setTimeout(() => this.openSubmenu(action, button, false), 140); });
      button.addEventListener('pointerleave', () => window.clearTimeout(this.hoverTimer));
      button.addEventListener('click', () => this.openSubmenu(action, button, true));
      button.addEventListener('keydown', event => { if (event.key === 'ArrowRight') { event.preventDefault(); this.openSubmenu(action, button, true); } });
    } else {
      button.addEventListener('pointerenter', () => { if (this.list.contains(button)) this.closeSubmenu(); });
      button.addEventListener('click', () => {
        if (button.disabled) return;
        void Promise.resolve().then(() => action.run?.()).catch(error => this.status(error instanceof Error ? error.message : String(error)));
      });
    }
    return button;
  }
  private openSubmenu(action: BlockAction, button: HTMLButtonElement, focus: boolean) {
    if (this.closed || button.disabled) return;
    if (this.parentButton !== button) {
      this.closeSubmenu(); this.parentButton = button; button.setAttribute('aria-expanded', 'true');
      const submenu = document.createElement('section'); submenu.className = 'meki-block-menu meki-block-submenu';
      submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', action.label);
      const heading = document.createElement('div'); heading.className = 'meki-block-menu-title'; heading.textContent = action.label; submenu.append(heading);
      for (const child of action.children!) submenu.append(this.button(child));
      submenu.addEventListener('keydown', this.keydown); document.body.append(submenu); this.submenu = submenu;
      void this.position(submenu, button, 'right-start').then(() => {
        if (focus && this.submenu === submenu) submenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
      });
      return;
    }
    if (focus) this.submenu?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  private closeSubmenu() {
    window.clearTimeout(this.hoverTimer); this.submenu?.remove(); this.submenu = null;
    this.parentButton?.setAttribute('aria-expanded', 'false'); this.parentButton = null;
  }
  private keydown = (event: KeyboardEvent) => {
    const inSubmenu = Boolean(this.submenu?.contains(event.target as Node));
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && inSubmenu)) {
      event.preventDefault(); event.stopPropagation();
      if (this.submenu) { const parent = this.parentButton; this.closeSubmenu(); parent?.focus({ preventScroll: true }); }
      else this.close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab', 'Enter'].includes(event.key)) return;
    if (event.target === this.input && ['Home', 'End'].includes(event.key)) return;
    const buttons = [...(inSubmenu ? this.submenu! : this.list).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) { if (event.key === 'Tab') event.preventDefault(); return; }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Enter') { if (event.target === this.input) { event.preventDefault(); buttons[0].click(); } return; }
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Tab' && !inSubmenu && ((event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1))) { this.input.focus(); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true }); buttons[next].scrollIntoView({ block: 'nearest' });
  };
}

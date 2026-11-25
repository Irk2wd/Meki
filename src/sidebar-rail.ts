import { t } from '../electron/i18n.mjs';
import './sidebar-rail.css';

export class SidebarRail {
  private narrow = matchMedia('(max-width: 760px)');
  private desktopExpanded = true;
  private narrowExpanded = false;

  constructor(private saveDesktop: (expanded: boolean) => void) {
    const sidebar = document.querySelector<HTMLElement>('#app-sidebar')!;
    const pointerHints = () => sidebar.removeAttribute('data-keyboard-hints');
    document.addEventListener('pointermove', pointerHints, { passive: true });
    document.addEventListener('pointerdown', pointerHints, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Tab' || sidebar.contains(document.activeElement)) {
        sidebar.toggleAttribute('data-keyboard-hints', event.key !== 'Escape');
      }
    }, true);
    this.narrow.addEventListener('change', () => {
      this.narrowExpanded = false;
      this.apply(this.desktopExpanded);
    });
  }

  get expanded() {
    return this.narrow.matches ? this.narrowExpanded : this.desktopExpanded;
  }

  apply(desktopExpanded: boolean) {
    this.desktopExpanded = desktopExpanded;
    document.body.classList.toggle('sidebar-hidden', !this.expanded);
    for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-action="sidebar"]')) {
      toggle.setAttribute('aria-expanded', String(this.expanded));
      toggle.setAttribute('aria-controls', 'app-sidebar');
      toggle.title = toggle.ariaLabel = this.expanded ? t("收起侧栏") : t("展开侧栏");
    }
  }

  setExpanded(expanded: boolean) {
    if (this.expanded === expanded) return;
    if (this.narrow.matches) {
      this.narrowExpanded = expanded;
      this.apply(this.desktopExpanded);
    } else this.saveDesktop(expanded);
  }
}

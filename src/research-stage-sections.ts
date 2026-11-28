import { ht } from '../electron/i18n.mjs';
import { icon } from './icons';
import './research-stage-sections.css';

export class StageSections {
  private prefix = '';
  private unsaved = new Map<string, boolean>();

  constructor(private heading: 'h3' | 'h4' = 'h3') {}

  forPhase(workspace: string, project: string, phase: string) {
    this.prefix = 'mekir.research.stageSections.' + JSON.stringify([workspace, project, phase]) + '.';
  }

  private isCollapsed(id: string) {
    const key = this.prefix + id;
    const pending = this.unsaved.get(key);
    if (pending !== undefined) return pending;
    try { return localStorage.getItem(key) === 'collapsed'; }
    catch { return false; }
  }

  render(id: string, title: string, body: string, { actions = '', count }: { actions?: string; count?: number } = {}) {
    const collapsed = this.isCollapsed(id);
    return `<div class="research-disclosure-heading"><${this.heading} id="${id}" tabindex="-1">
      <button type="button" data-research-section-toggle="${id}" aria-expanded="${!collapsed}" aria-controls="${id}-body"${count === undefined ? '' : ` aria-description="${ht("共 {0} 条", count)}"`}>
        ${icon('chevron', 14)}${title}${count === undefined ? '' : ` <span aria-hidden="true">${count}</span>`}</button></${this.heading}>${actions}</div>
      <div data-stage-section-body id="${id}-body"${collapsed ? ' hidden' : ''}>${body}</div>`;
  }

  toggle(button: HTMLButtonElement, remember = true) {
    const id = button.dataset.researchSectionToggle!;
    const body = document.getElementById(button.getAttribute('aria-controls')!);
    if (!body) return;
    const collapsed = !body.hidden;
    body.hidden = collapsed;
    button.setAttribute('aria-expanded', String(!collapsed));
    // A heading can still announce a hidden page range through aria-describedby.
    const heading = button.parentElement;
    if (collapsed && heading?.getAttribute('aria-describedby') === `${id}-range`) {
      heading.removeAttribute('aria-describedby');
    }
    if (!remember) return;
    const key = this.prefix + id;
    // Independent keys keep simultaneous changes to different sections in separate windows.
    try {
      if (collapsed) localStorage.setItem(key, 'collapsed');
      else localStorage.removeItem(key);
      this.unsaved.delete(key);
    } catch { this.unsaved.set(key, collapsed); }
  }
}

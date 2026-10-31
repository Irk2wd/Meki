import { ht, t } from '../electron/i18n.mjs';
import { buildOutline, visibleOutline, type OutlineEntry } from './outline';
import type { WritingEditor } from './editor';
import { numberHeadings, numberedHeadingTitle } from './heading-numbering';
import type { Settings } from '../shared/moye';
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export class OutlinePanel {
  private get editor() { return this.getEditor(); }
  private entries: OutlineEntry[] = [];
  private collapsed = new Set<string>();
  private content = '';
  private frame = 0;
  private active = -1;
  private numbered = false;
  constructor(private getEditor: () => WritingEditor, private blocked: () => boolean) {
    const panel = document.querySelector('#outline-panel')!;
    panel.insertAdjacentHTML('afterbegin', `<div class="outline-controls"><span>${ht("文稿大纲")}</span><button data-outline-control="expand" title="${ht("展开全部")}">${ht("展开")}</button><button data-outline-control="collapse" title="${ht("折叠全部")}">${ht("折叠")}</button></div>`);
    panel.addEventListener('click', event => {
      const target = event.target as HTMLElement, control = target.closest<HTMLElement>('[data-outline-control]')?.dataset.outlineControl;
      if (control) { this.collapsed = control === 'expand' ? new Set() : new Set(this.entries.filter(entry => entry.children).map(entry => entry.id)); this.render(); return; }
      const toggle = target.closest<HTMLElement>('[data-outline-toggle]');
      if (toggle) { const id = toggle.dataset.outlineToggle!; if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id); this.render(); return; }
      const item = target.closest<HTMLElement>('[data-outline-index]');
      if (item && !this.blocked()) { const index = Number(item.dataset.outlineIndex); this.editor.goToHeading(index, this.entries[index].offset); this.active = index; this.highlight(); }
    });
    document.querySelector('#editor-workspace')!.addEventListener('scroll', () => this.schedule(), { passive: true, capture: true });
    new ResizeObserver(() => this.schedule()).observe(document.querySelector('#editor-workspace')!);
  }
  reset() { this.collapsed.clear(); this.content = '\0'; this.active = -1; }
  apply(settings: Pick<Settings, 'headingNumbering'>) { if (this.numbered !== settings.headingNumbering) { this.numbered = settings.headingNumbering; this.render(); } }
  update(content: string) { if (content !== this.content) { this.content = content; this.entries = buildOutline(content); this.render(); } this.schedule(); }
  schedule() { if (this.frame) cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => { this.frame = 0; this.active = this.editor.activeHeading(this.entries); this.highlight(); }); }
  private render() {
    const visible = visibleOutline(this.entries, this.collapsed), numbers = this.numbered ? numberHeadings(this.entries.map(entry => entry.level)) : [];
    document.querySelector('#outline-list')!.innerHTML = this.entries.length ? this.entries.map((entry, index) => `<div class="outline-row" style="--depth:${entry.level}" ${visible[index] ? '' : 'hidden'}>${entry.children ? `<button class="outline-toggle" data-outline-toggle="${escape(entry.id)}" aria-label="${this.collapsed.has(entry.id) ? t("展开") : t("折叠")} ${escape(entry.text)}" aria-expanded="${!this.collapsed.has(entry.id)}">${this.collapsed.has(entry.id) ? '▸' : '▾'}</button>` : '<span class="outline-toggle-spacer"></span>'}<button class="outline-item" data-outline-index="${index}" title="${escape(entry.text)}"><span>${escape(numberedHeadingTitle(entry.text, numbers[index]))}</span></button></div>`).join('') : `<div class="empty-nav"><span>${ht("思路，从一个标题开始。")}</span><small>${ht("输入 # 加空格，写下章节标题。")}</small></div>`;
    this.highlight();
  }
  private highlight() {
    const visible = visibleOutline(this.entries, this.collapsed); let active = this.active;
    while (active >= 0 && !visible[active]) active = this.entries[active]?.parent ?? -1;
    document.querySelectorAll<HTMLElement>('[data-outline-index]').forEach(button => {
      const selected = Number(button.dataset.outlineIndex) === active;
      button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
    });
  }
}

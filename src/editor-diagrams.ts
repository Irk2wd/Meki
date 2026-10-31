import { t } from '../electron/i18n.mjs';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { renderDiagram, type RenderedDiagram } from './diagram-engine';
import { diagramTheme, type DiagramTheme } from './diagram-policy';

export class EditorDiagrams {
  private theme: DiagramTheme = 'paper';
  private prefix = `editor-${crypto.randomUUID()}`;
  private view?: EditorView;
  private timer = 0;
  private signature = '';
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private results: RenderedDiagram[] = [];
  updateSettings(settings: { theme?: string }) { this.theme = diagramTheme(settings.theme); this.schedule(); }
  private schedule() { if (!this.timer) this.timer = window.setTimeout(() => { this.timer = 0; void this.render(); }, 80); }
  async flush() { if (this.timer) clearTimeout(this.timer); this.timer = 0; await this.render(); }
  blockPreview(_source: string) { const dom = document.createElement('div'); dom.className = 'moye-block-diagram'; dom.textContent = t("图表渲染中…"); this.schedule(); return dom; }
  private entries() {
    const entries: Array<{ pos: number; source: string }> = [];
    this.view?.state.doc.descendants((node, pos) => { if (node.type.name === 'code_block' && String(node.attrs.language).toLowerCase() === 'mermaid') entries.push({ pos, source: node.textContent }); });
    return entries;
  }
  private async render() {
    if (!this.view) return;
    const view = this.view, entries = this.entries();
    const signature = JSON.stringify([this.theme, entries.map(entry => entry.source)]);
    if (signature !== this.signature) {
      this.signature = signature;
      const generation = ++this.generation;
      this.pending = Promise.all(entries.map((entry, index) => renderDiagram(entry.source, { theme: this.theme, id: `${this.prefix}-${index}` }))).then(results => {
        if (this.view !== view || generation !== this.generation) return;
        this.results = results; this.apply();
      });
    }
    await this.pending;
    if (this.view === view && this.signature === signature) this.apply();
  }
  private apply() {
    const view = this.view; if (!view) return;
    const entries = this.entries();
    if (JSON.stringify([this.theme, entries.map(entry => entry.source)]) !== this.signature) return;
    const active = new Set<HTMLElement>();
    entries.forEach(({ pos }, index) => {
      const node = view.nodeDOM(pos), result = this.results[index];
      if (!(node instanceof HTMLElement) || !result) return;
      active.add(node);
      let dom = node.querySelector<HTMLElement>('.moye-block-diagram');
      if (!dom && node.querySelector('.milkdown-code-block-placeholder')) { dom = document.createElement('div'); dom.className = 'moye-block-diagram moye-lazy-diagram'; node.append(dom); }
      if (dom && dom.dataset.diagramHtml !== result.html) { dom.dataset.diagramHtml = result.html; dom.innerHTML = result.html; }
    });
    view.dom.querySelectorAll<HTMLElement>('.moye-lazy-diagram').forEach(dom => { if (!active.has(dom.parentElement!)) dom.remove(); });
  }
  plugin = $prose(() => new Plugin({ view: view => {
    this.view = view; this.signature = ''; this.results = []; this.generation++;
    const observer = new MutationObserver(() => this.schedule()); observer.observe(view.dom, { childList: true, subtree: true }); this.schedule();
    return { update: next => { this.view = next; this.schedule(); }, destroy: () => { observer.disconnect(); if (this.timer) clearTimeout(this.timer); this.timer = 0; this.view = undefined; this.signature = ''; this.generation++; } };
  } }));
}

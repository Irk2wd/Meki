import { t } from '../electron/i18n.mjs';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { renderMathDocument, type MathSettings, type RenderedMath } from './math-engine';

/** Compile in document order so duplicate expressions and forward refs retain their identity. */
export class EditorMath {
  private settings: MathSettings = {};
  private prefix = `moye-editor-${crypto.randomUUID()}`;
  private view?: EditorView;
  private frame = 0;
  private signature = '';
  private results: Array<{ pos: number; tex: string; display: boolean; result: RenderedMath }> = [];
  private style?: HTMLStyleElement;
  updateSettings(settings: MathSettings) { this.settings = { mathNumbering: settings.mathNumbering, mathPhysics: settings.mathPhysics }; this.signature = ''; this.schedule(); }
  flush() { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.render(); }
  private schedule() { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); }); }
  blockPreview(tex: string) { const dom = document.createElement('div'); dom.className = 'moye-block-math'; dom.textContent = tex; this.schedule(); return dom; }
  private render() {
    if (!this.view) return;
    const entries: Array<{ pos: number; tex: string; display: boolean }> = [];
    this.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'math_inline') entries.push({ pos, tex: node.attrs.value, display: false });
      else if (node.type.name === 'code_block' && String(node.attrs.language).toLowerCase() === 'latex') entries.push({ pos, tex: node.textContent, display: true });
    });
    // Typing ordinary prose can shift every position without changing the formula document.
    const signature = JSON.stringify([entries.map(({ tex, display }) => ({ tex, display })), this.settings]);
    if (signature !== this.signature) {
      const rendered = renderMathDocument(entries, this.settings, this.prefix);
      this.results = entries.map((entry, index) => ({ ...entry, result: rendered.items[index] })); this.signature = signature;
      if (this.style && this.style.textContent !== rendered.css) this.style.textContent = rendered.css;
    }
    else this.results = entries.map((entry, index) => ({ ...entry, result: this.results[index].result }));
    const activeBlocks = new Set<HTMLElement>();
    for (const { pos, tex, display, result } of this.results) {
      const node = this.view.nodeDOM(pos);
      let dom = node instanceof HTMLElement ? display ? node.querySelector<HTMLElement>('.moye-block-math') : node : null;
      if (display && node instanceof HTMLElement) {
        activeBlocks.add(node);
        // CodeMirror intentionally unmounts offscreen blocks. Its cheap placeholder still needs
        // a preview for document layout, anchors and printing; Vue replaces this when it mounts.
        if (!dom && node.querySelector('.milkdown-code-block-placeholder')) {
          dom = document.createElement('div'); dom.className = 'moye-block-math moye-lazy-math'; node.append(dom);
        }
      }
      if (dom && dom.dataset.mathHtml !== result.html) { dom.dataset.mathHtml = result.html; dom.innerHTML = result.html; }
      if (dom) {
        dom.dataset.mathTex = tex;
        dom.dataset.mathml = result.mathml || '';
        dom.title = t("右键复制 LaTeX 或 MathML");
      }
    }
    this.view.dom.querySelectorAll<HTMLElement>('.moye-lazy-math').forEach(dom => { if (!activeBlocks.has(dom.parentElement!)) dom.remove(); });
  }
  plugin = $prose(() => new Plugin({
    props: { nodeViews: { math_inline: node => {
      const dom = document.createElement('span'); dom.dataset.type = 'math_inline'; dom.dataset.value = node.attrs.value; dom.className = 'moye-inline-math'; dom.contentEditable = 'false'; dom.textContent = node.attrs.value;
      return { dom, ignoreMutation: () => true, update: next => { if (next.type.name !== 'math_inline') return false; dom.dataset.value = next.attrs.value; return true; } };
    } } },
    view: view => {
      this.view = view; this.signature = ''; this.style = document.createElement('style'); this.style.dataset.moyeMath = 'true'; document.head.append(this.style);
      const observer = new MutationObserver(() => this.schedule()); observer.observe(view.dom, { childList: true, subtree: true }); this.schedule();
      return { update: next => { this.view = next; this.schedule(); }, destroy: () => { observer.disconnect(); if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.style?.remove(); this.view = undefined; } };
    },
  }));
}

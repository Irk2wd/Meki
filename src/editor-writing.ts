import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView as ProseView } from '@milkdown/kit/prose/view';
import { StateEffect } from '@codemirror/state';
import { Decoration as CodeDecoration, ViewPlugin, type DecorationSet as CodeDecorationSet, type EditorView as CodeView } from '@codemirror/view';
import type { Settings } from '../shared/moye';
import { countWords } from './search';

const refreshWriting = StateEffect.define<null>();
export class EditorWriting {
  onSelection: (words: number, characters: number) => void = () => {};
  private settings = { typewriter: false, paragraphFocus: false, spellcheck: false };
  private frame = 0;
  private selecting = false;
  constructor(private visual: () => ProseView, private source: () => CodeView, private mode: () => 'visual' | 'source') {}
  updateSettings(settings: Settings) {
    this.settings = { typewriter: settings.typewriter, paragraphFocus: settings.paragraphFocus, spellcheck: settings.spellcheck };
    document.body.classList.toggle('typewriter-mode', settings.typewriter);
    document.body.classList.toggle('paragraph-focus-mode', settings.paragraphFocus);
    const view = this.visual(); view.dom.spellcheck = settings.spellcheck;
    this.source().contentDOM.spellcheck = settings.spellcheck;
    view.dispatch(view.state.tr.setMeta('moye-writing', true).setMeta('addToHistory', false));
    this.source().dispatch({ effects: refreshWriting.of(null) }); this.updated();
  }
  updated() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  }
  private measure() {
    let selected = '';
    const sourceMode = this.mode() === 'source';
    const view = sourceMode ? this.source() : this.visual();
    this.source().contentDOM.spellcheck = this.settings.spellcheck;
    if (sourceMode) {
      const state = this.source().state;
      selected = state.selection.ranges.map(range => state.sliceDoc(range.from, range.to)).join('\n');
    } else {
      const { doc, selection } = this.visual().state;
      selected = doc.textBetween(selection.from, selection.to, '\n', node => String(node.attrs.value || ''));
    }
    this.onSelection(countWords(selected), [...selected].length);
    const focused = sourceMode ? this.source().hasFocus : this.visual().hasFocus();
    const empty = sourceMode ? this.source().state.selection.ranges.every(range => range.empty) : this.visual().state.selection.empty;
    // Dragging must keep the text under the pointer, including the initial collapsed caret.
    if (!this.settings.typewriter || !focused || view.composing || this.selecting || !empty) return;
    const head = sourceMode ? this.source().state.selection.main.head : this.visual().state.selection.head;
    const coordinates = view.coordsAtPos(head); if (!coordinates) return;
    const scroll = sourceMode ? this.source().scrollDOM : this.visual().dom.closest<HTMLElement>('.document-scroll');
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect(), delta = (coordinates.top + coordinates.bottom) / 2 - (bounds.top + scroll.clientHeight * .46);
    if (Math.abs(delta) > 2) scroll.scrollTop += delta;
  }
  plugin = $prose(() => new Plugin({
    props: { decorations: state => {
      if (!this.settings.paragraphFocus) return DecorationSet.empty;
      const { $head } = state.selection;
      let active = $head.depth ? $head.before($head.depth) : state.selection.from;
      for (let depth = $head.depth; depth > 0; depth--) if ($head.node(depth).isTextblock) { active = $head.before(depth); break; }
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.isTextblock || node.isBlock && node.isAtom) { decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: pos === active ? 'moye-current-paragraph' : 'moye-inactive-paragraph' })); return false; }
      });
      return DecorationSet.create(state.doc, decorations);
    } },
    view: view => {
      const targets = [view.dom, this.source().dom];
      const begin = (event: PointerEvent) => { if (event.button === 0) this.selecting = true; };
      const end = () => { this.selecting = false; };
      for (const target of targets) target.addEventListener('pointerdown', begin, true);
      for (const event of ['pointerup', 'pointercancel']) window.addEventListener(event, end, true);
      window.addEventListener('blur', end);
      return {
        update: (view, previous) => { if (this.mode() === 'visual' && (view.state.doc !== previous.doc || !view.state.selection.eq(previous.selection))) this.updated(); },
        destroy: () => {
          for (const target of targets) target.removeEventListener('pointerdown', begin, true);
          for (const event of ['pointerup', 'pointercancel']) window.removeEventListener(event, end, true);
          window.removeEventListener('blur', end);
          cancelAnimationFrame(this.frame); this.frame = 0; end();
        },
      };
    },
  }));
  sourceExtension = ViewPlugin.fromClass(class {
    decorations: CodeDecorationSet = CodeDecoration.none;
    constructor(readonly view: CodeView) { this.render(); }
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; transactions: readonly { effects: readonly StateEffect<unknown>[] }[] }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshWriting)))) this.render();
    }
    render() {
      const owner = this.view.state.facet(writingOwner)[0];
      if (!owner?.settings.paragraphFocus) { this.decorations = CodeDecoration.none; return; }
      const doc = this.view.state.doc, selected = doc.lineAt(this.view.state.selection.main.head);
      let from = selected.number, to = selected.number;
      while (from > 1 && doc.line(from - 1).text.trim() && doc.line(from).text.trim()) from--;
      while (to < doc.lines && doc.line(to + 1).text.trim() && doc.line(to).text.trim()) to++;
      const ranges = [];
      for (const visible of this.view.visibleRanges) {
        for (let number = doc.lineAt(visible.from).number; number <= doc.lineAt(visible.to).number; number++) {
          const line = doc.line(number); ranges.push(CodeDecoration.line({ class: number >= from && number <= to ? 'moye-current-paragraph' : 'moye-inactive-paragraph' }).range(line.from));
        }
      }
      this.decorations = CodeDecoration.set(ranges, true);
    }
  }, { decorations: value => value.decorations });
  get sourceConfig() { return [writingOwner.of(this), this.sourceExtension]; }
}

import { Facet } from '@codemirror/state';
const writingOwner = Facet.define<EditorWriting>();

import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { codeHighlightStyle } from './code-highlight';
import { indentWithTab, insertNewline, insertNewlineAndIndent } from '@codemirror/commands';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import { isHistoryTransaction } from '@milkdown/kit/prose/history';
import type { Node } from '@milkdown/kit/prose/model';
import { codeDefaults, newCodeLanguage, validCodeLanguage, type CodeOptions } from './code-options';
import type { Settings } from '../shared/moye';

export class EditorCode {
  private settings = { ...codeDefaults };
  private compartment = new Compartment();
  private views = new Set<EditorView>();
  private transferring = false;
  onLastLanguage: (language: string) => void = () => {};
  loading = false;
  readonly theme = EditorView.theme({
    '&': { backgroundColor: 'var(--side)', color: 'var(--text)' },
    '.cm-gutters': { backgroundColor: 'var(--side)', color: 'var(--soft)', border: 'none' },
    '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
    '.cm-cursor,.cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground,&.cm-focused .cm-selectionBackground,::selection': { backgroundColor: 'var(--selection)' },
  });
  language() { return newCodeLanguage(this.settings); }
  updateSettings(settings: Settings) {
    const next = Object.fromEntries(Object.keys(codeDefaults).map(key => [key, settings[key as keyof CodeOptions]])) as CodeOptions;
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.settings = { ...next };
    for (const view of this.views) view.dispatch({ effects: this.compartment.reconfigure(this.configuration()) });
  }
  private configuration(): Extension {
    return [
      this.settings.codeWrap ? EditorView.lineWrapping : [],
      indentUnit.of(this.settings.codeUseTabs ? '\t' : ' '.repeat(this.settings.codeIndentSize)),
      EditorState.tabSize.of(this.settings.codeTabSize),
      Prec.highest(keymap.of([indentWithTab, { key: 'Enter', run: this.settings.codeAutoIndent ? insertNewlineAndIndent : insertNewline }])),
    ];
  }
  // Crepe destroys offscreen CodeMirror views. Newly mounted views must get current settings.
  readonly extension: Extension = (() => {
    const owner = this;
    return [syntaxHighlighting(codeHighlightStyle), this.compartment.of(this.configuration()), ViewPlugin.fromClass(class {
      constructor(readonly view: EditorView) {
        owner.views.add(view);
        queueMicrotask(() => { if (owner.views.has(view)) view.dispatch({ effects: owner.compartment.reconfigure(owner.configuration()) }); });
      }
      destroy() { owner.views.delete(this.view); }
    })];
  })();
  private remember(language: unknown) {
    if (this.loading || typeof language !== 'string' || !language || !validCodeLanguage(language) || language === this.settings.codeLastLanguage) return;
    this.settings.codeLastLanguage = language;
    queueMicrotask(() => this.onLastLanguage(language));
  }
  readonly plugin = $prose(() => new Plugin({
    props: { handleDOMEvents: {
      paste: () => this.transferEvent(), drop: () => this.transferEvent(),
    } },
    appendTransaction: (transactions, previous, state) => {
      const language = this.language();
      if (this.loading || this.transferring || !language || !transactions.some(tr => tr.docChanged) || transactions.some(tr => isHistoryTransaction(tr) || tr.getMeta('moye-preserve-code-language') || tr.getMeta('paste') || tr.getMeta('uiEvent') === 'paste')) return;
      const oldPositions = new Set<number>();
      previous.doc.descendants((node, pos) => {
        if (node.type.name !== 'code_block') return;
        for (const transaction of transactions) pos = transaction.mapping.map(pos, 1);
        oldPositions.add(pos);
      });
      const blocks: Array<{ node: Node; pos: number }> = [];
      state.doc.descendants((node, pos) => { if (node.type.name === 'code_block') blocks.push({ node, pos }); });
      if (blocks.length <= oldPositions.size) return;
      const transaction = state.tr;
      for (const { node, pos } of blocks) if (!oldPositions.has(pos) && !node.attrs.language) transaction.setNodeAttribute(pos, 'language', language);
      return transaction.docChanged ? transaction : undefined;
    },
    view: () => ({ update: (view, previous) => {
      if (this.loading || view.state.doc === previous.doc && view.state.selection.eq(previous.selection)) return;
      const parent = view.state.selection.$from.parent;
      if (parent.type.name === 'code_block') this.remember(parent.attrs.language);
    } }),
  }));
  private transferEvent() { this.transferring = true; queueMicrotask(() => { this.transferring = false; }); return false; }
}

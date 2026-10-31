import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState as ProseState } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { closeHistory } from '@milkdown/kit/prose/history';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import type { EditorView as CodeView } from '@codemirror/view';
import { typingAction, pairedBackspace, typingDefaults, type PairToken, type TypingContext, type TypingSettings, type TypingAction } from './typing-rules.ts';

type TrackedPair = PairToken & { pos: number };
const pairKey = new PluginKey<TrackedPair[]>('moye-typing-pairs');
function context(state: ProseState, from: number, to: number, input: string, composing: boolean): { value: TypingContext; offset: number } | null {
  if (!(state.selection instanceof TextSelection)) return null;
  const start = state.doc.resolve(from), end = state.doc.resolve(to);
  if (!start.sameParent(end) || !start.parent.isTextblock || start.parent.type.spec.code) return null;
  for (let depth = start.depth; depth > 0; depth--) if (/code|math|html|raw/.test(start.node(depth).type.name)) return null;
  let protectedContent = false;
  const codeMark = (name: string) => /code|math/.test(name);
  if ((state.storedMarks || start.marks()).some(mark => mark.type.spec.code || codeMark(mark.type.name))) return null;
  if (from < to) state.doc.nodesBetween(from, to, node => { if (node.isInline && !node.isText || node.marks.some(mark => mark.type.spec.code || codeMark(mark.type.name))) protectedContent = true; });
  const offset = start.start();
  // One character per inline atom keeps offsets identical to ProseMirror's positions.
  const text = start.parent.textBetween(0, start.parent.content.size, '\n', '\uFFFC');
  const tracked = pairKey.getState(state)?.find(pair => pair.pos === from);
  return { offset, value: { text, from: from - offset, to: to - offset, input, composing, protected: protectedContent, tracked } };
}
function apply(view: ProseView, action: TypingAction, offset: number) {
  const { state } = view; let tr = state.tr;
  if (action.kind === 'skip') { view.dispatch(tr.setSelection(TextSelection.create(tr.doc, offset + action.cursor)).setMeta('addToHistory', false)); return true; }
  const from = offset + action.from, to = offset + action.to;
  if (action.kind === 'replace') tr.insertText(action.text, from, to).setSelection(TextSelection.create(tr.doc, offset + action.cursor));
  if (action.kind === 'wrap') {
    tr.insertText(action.pair.close, to).insertText(action.pair.open, from);
    tr.setSelection(TextSelection.create(tr.doc, from + action.pair.open.length, to + action.pair.open.length));
    tr.setMeta(pairKey, { ...action.pair, pos: to + action.pair.open.length });
  }
  if (action.kind === 'mark') {
    const mark = state.schema.marks[action.mark]; if (!mark) return false;
    const repeated = action.mark === 'emphasis' ? state.schema.marks.strong : action.mark === 'moye_sub' ? state.schema.marks.strike_through : null;
    if (repeated && state.doc.rangeHasMark(from, to, mark)) tr.removeMark(from, to, mark).addMark(from, to, repeated.create());
    else tr.addMark(from, to, mark.create());
  }
  if (action.kind === 'math') {
    const math = state.schema.nodes.math_inline; if (!math) return false;
    tr.replaceWith(from, to, math.create({ value: action.tex }));
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
  }
  view.dispatch(closeHistory(tr).setMeta('moye-typing', true).scrollIntoView());
  return true;
}
export function typingPlugin(settings: () => TypingSettings) {
  let compositionUntil = 0;
  return new Plugin<TrackedPair[]>({
    key: pairKey,
    state: {
      init: () => [],
      apply: (tr, previous) => {
        const pairs = previous.flatMap(pair => {
          const mapped = tr.mapping.mapResult(pair.pos, 1);
          return !mapped.deleted && mapped.pos >= 0 && mapped.pos + pair.close.length <= tr.doc.content.size && tr.doc.textBetween(mapped.pos, mapped.pos + pair.close.length) === pair.close ? [{ ...pair, pos: mapped.pos }] : [];
        });
        const added = tr.getMeta(pairKey) as TrackedPair | undefined; if (added) pairs.push(added);
        return pairs.slice(-256);
      },
    },
    // The edit is one document transaction; a non-document history boundary keeps
    // subsequent typing out of that undo step, like existing editor actions.
    appendTransaction: (transactions, _previous, next) => transactions.some(tr => tr.getMeta('moye-typing')) ? closeHistory(next.tr) : null,
    props: {
      handleDOMEvents: {
        compositionstart: () => { compositionUntil = Infinity; return false; },
        compositionend: () => { compositionUntil = Date.now() + 50; return false; },
        blur: () => { if (compositionUntil === Infinity) compositionUntil = Date.now() + 50; return false; },
      },
      handleTextInput: (view, from, to, input) => {
        const options = settings();
        if (options.typingAutoPair !== 'on' && !options.typingMarkdownPairs && !options.typingSmartQuotes && !options.typingSmartDashes) return false;
        const point = context(view.state, from, to, input, view.composing || Date.now() < compositionUntil); if (!point) return false;
        const action = typingAction(point.value, options); return action ? apply(view, action, point.offset) : false;
      },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Backspace' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return false;
        const options = settings(); if (options.typingAutoPair !== 'on') return false;
        const { from, to } = view.state.selection;
        const point = context(view.state, from, to, '', view.composing || Date.now() < compositionUntil); if (!point) return false;
        const action = pairedBackspace(point.value, options); return action ? apply(view, action, point.offset) : false;
      },
    },
  });
}
export class EditorTyping {
  private settings: TypingSettings = { ...typingDefaults };
  private source: () => CodeView;
  private sourceConfiguration = new Compartment();
  constructor(source: () => CodeView) { this.source = source; }
  private configuration() {
    // basicSetup already owns closeBrackets and its Backspace handler. Language
    // data controls both without adding a second input handler or changing text.
    return this.settings.typingAutoPair === 'off' ? Prec.high(EditorState.languageData.of(() => [{ closeBrackets: { brackets: [] } }])) : [];
  }
  get sourceExtension() { return this.sourceConfiguration.of(this.configuration()); }
  sourceRestored() { this.source().dispatch({ effects: this.sourceConfiguration.reconfigure(this.configuration()) }); }
  updateSettings(value: Partial<TypingSettings>) {
    this.settings = { ...typingDefaults, ...value };
    this.sourceRestored();
  }
  plugin = $prose(() => typingPlugin(() => this.settings));
}

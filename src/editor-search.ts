import { t } from '../electron/i18n.mjs';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, NodeSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { closeHistory, undo as proseUndo } from '@milkdown/kit/prose/history';
import { EditorSelection, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration as CodeDecoration, EditorView as CodeView, ViewPlugin as CodePlugin } from '@codemirror/view';
import { isolateHistory, undo as codeUndo } from '@codemirror/commands';
import { SearchClient } from './search-client';
import { replacementText, type SearchMatch, type SearchOptions, type SearchSegment } from './search';

interface Target extends SearchSegment { kind: 'text' | 'attribute' | 'source'; pos: number; size?: number; attribute?: string; code?: boolean }
export interface FindStatus { index: number; total: number; error: string | null; truncated: boolean; pending: boolean }
const searchKey = new PluginKey('moye-search');
const setCodeMarks = StateEffect.define<Array<{ from: number; to: number; active: boolean }>>();
const codeMarks = StateField.define({
  create: () => CodeDecoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setCodeMarks)) value = CodeDecoration.set(effect.value.filter(match => match.to > match.from).map(match => CodeDecoration.mark({ class: match.active ? 'moye-search-hit moye-search-current' : 'moye-search-hit' }).range(match.from, match.to)), true);
    return value;
  }, provide: field => CodeView.decorations.from(field),
});

/** Text runs span inline formatting, but never join separate block nodes or hidden attributes. */
export function visualSearchTargets(doc: ProseNode): Target[] {
  const targets: Target[] = [];
  const add = (target: Omit<Target, 'id'>) => { targets.push({ ...target, id: targets.length }); };
  const attribute = (node: ProseNode, pos: number) => {
    if (['math_inline', 'html', 'moye_raw'].includes(node.type.name)) add({ kind: 'attribute', pos, size: node.nodeSize, attribute: 'value', text: String(node.attrs.value || '') });
  };
  doc.descendants((node, pos) => {
    if (!node.isTextblock) { attribute(node, pos); return; }
    let text = '', start = pos + 1;
    const code = node.type.name === 'code_block' && !['latex', 'mermaid'].includes(String(node.attrs.language).toLowerCase());
    const flush = () => { if (text) add({ kind: 'text', pos: start, text, code }); text = ''; };
    node.forEach((child, offset) => {
      if (child.isText || child.type.name === 'hardbreak') { if (!text) start = pos + 1 + offset; text += child.isText ? child.text : '\n'; }
      else { flush(); attribute(child, pos + 1 + offset); }
    });
    flush(); return false;
  });
  return targets;
}

export class EditorSearch {
  onStatus: (status: FindStatus) => void = () => {};
  private client = new SearchClient();
  private options: SearchOptions = { query: '', caseSensitive: false, wholeWord: false, regex: false };
  private targets: Target[] = [];
  private matches: SearchMatch[] = [];
  private index = -1;
  private snapshot: ProseNode | string | null = null;
  private snapshotMode = '';
  private error: string | null = null;
  private truncated = false;
  private pending = false;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private scrollFrame = 0;
  private codeViews = new Set<CodeView>();
  private pendingCodeScroll: SearchMatch | null = null;
  constructor(private visual: () => ProseView, private source: () => CodeView, private mode: () => 'visual' | 'source', private changed: () => void) {}
  readonly sourceExtension = codeMarks;
  readonly codeExtension = [codeMarks, CodePlugin.define(view => {
    this.codeViews.add(view);
    // Crepe mounts offscreen code blocks lazily, after their placeholder becomes visible.
    queueMicrotask(() => {
      if (!this.codeViews.has(view)) return;
      this.decorateCode(view);
      if (this.pendingCodeScroll && this.pendingCodeScroll === this.matches[this.index]) this.revealCode(this.pendingCodeScroll);
    });
    return { destroy: () => { this.codeViews.delete(view); } };
  })];
  plugin = $prose(() => new Plugin({
    key: searchKey,
    props: { decorations: state => {
      if (this.snapshot !== state.doc || this.mode() !== 'visual') return DecorationSet.empty;
      const marks = this.matches.flatMap((match, index) => {
        const target = this.targets[match.segment], attrs = { class: index === this.index ? 'moye-search-hit moye-search-current' : 'moye-search-hit' };
        if (target.code) return [];
        if (target.kind === 'attribute') return [Decoration.node(target.pos, target.pos + target.size!, attrs)];
        return match.from === match.to ? [] : [Decoration.inline(target.pos + match.from, target.pos + match.to, attrs)];
      });
      return DecorationSet.create(state.doc, marks);
    } },
    view: () => ({ update: (view, previous) => { if (view.state.doc !== previous.doc && this.mode() === 'visual') this.documentChanged(); } }),
  }));
  private status() { this.onStatus({ index: this.index + 1, total: this.matches.length, error: this.error, truncated: this.truncated, pending: this.pending }); }
  private currentSnapshot() { return this.mode() === 'source' ? this.source().state.doc.toString() : this.visual().state.doc; }
  private currentPosition() { return this.mode() === 'source' ? this.source().state.selection.main.from : this.visual().state.selection.from; }
  private absolute(match: SearchMatch) { const target = this.targets[match.segment]; return target.pos + (target.kind === 'attribute' ? 0 : match.from); }
  private decorate() {
    if (this.mode() === 'source') this.source().dispatch({ effects: setCodeMarks.of(this.matches.map((match, index) => ({ from: match.from, to: match.to, active: index === this.index }))) });
    else { const view = this.visual(); view.dispatch(view.state.tr.setMeta(searchKey, true).setMeta('addToHistory', false)); }
    for (const view of this.codeViews) this.decorateCode(view);
  }
  private decorateCode(view: CodeView) {
    const visual = this.visual();
    const target = this.active && this.mode() === 'visual' && this.snapshot === visual.state.doc
      ? this.targets.find(target => target.code && visual.nodeDOM(target.pos - 1)?.contains(view.dom)) : null;
    view.dispatch({ effects: setCodeMarks.of(target ? this.matches.flatMap((match, index) => match.segment === target.id ? [{ from: match.from, to: match.to, active: index === this.index }] : []) : []) });
  }
  private revealCode(match: SearchMatch) {
    const target = this.targets[match.segment];
    if (!target?.code || !this.active || this.mode() !== 'visual' || this.snapshot !== this.visual().state.doc) return false;
    const block = this.visual().nodeDOM(target.pos - 1), view = [...this.codeViews].find(view => block?.contains(view.dom));
    if (!view) return false;
    view.dispatch({ effects: CodeView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'nearest', yMargin: 24 }) });
    this.pendingCodeScroll = null; return true;
  }
  async setOptions(options: SearchOptions, select = true) { this.options = options; this.active = true; await this.refresh(select); }
  documentChanged() {
    if (!this.active) return;
    this.revision++; this.client.cancel(); this.matches = []; this.index = -1; this.pending = true; this.status();
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh(false); }, 70);
  }
  documentSwitched() {
    this.revision++; this.client.cancel(); clearTimeout(this.timer);
    this.targets = []; this.matches = []; this.index = -1; this.snapshot = null;
    this.pending = false; this.error = null; this.truncated = false;
    this.source().dispatch({ effects: setCodeMarks.of([]) });
    this.decorate(); this.status();
    if (this.active) void this.refresh(false);
  }
  modeChanged() { if (this.active) void this.refresh(true); }
  close() { this.active = false; this.revision++; this.client.cancel(); clearTimeout(this.timer); cancelAnimationFrame(this.scrollFrame); this.pendingCodeScroll = null; this.matches = []; this.index = -1; this.error = null; this.pending = false; this.decorate(); this.status(); }
  private async refresh(select: boolean, start = this.currentPosition()) {
    clearTimeout(this.timer);
    this.pendingCodeScroll = null;
    const revision = ++this.revision, snapshot = this.currentSnapshot(), mode = this.mode();
    this.snapshot = snapshot; this.snapshotMode = mode;
    this.targets = mode === 'source' ? [{ id: 0, kind: 'source', pos: 0, text: snapshot as string }] : visualSearchTargets(snapshot as ProseNode);
    this.matches = []; this.index = -1; this.error = null; this.pending = Boolean(this.options.query); this.decorate(); this.status();
    const result = await this.client.run(this.targets, this.options);
    if (!result || revision !== this.revision || mode !== this.mode() || snapshot !== this.currentSnapshot()) return;
    this.pending = false; this.matches = result.matches; this.error = result.error; this.truncated = result.truncated;
    this.index = this.matches.findIndex(match => this.absolute(match) >= start); if (this.index < 0 && this.matches.length) this.index = 0;
    this.decorate(); if (select) this.select(); this.status();
  }
  private select() {
    cancelAnimationFrame(this.scrollFrame);
    this.pendingCodeScroll = null;
    const match = this.matches[this.index]; if (!match) return;
    if (this.mode() === 'source') this.source().dispatch({ selection: { anchor: match.from, head: match.to }, effects: CodeView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'nearest', yMargin: 24 }) });
    else {
      const view = this.visual(), target = this.targets[match.segment];
      const selection = target.kind === 'attribute' ? NodeSelection.create(view.state.doc, target.pos) : TextSelection.create(view.state.doc, target.pos + match.from, target.pos + match.to);
      view.dispatch(view.state.tr.setSelection(selection).scrollIntoView().setMeta('addToHistory', false));
      if (target.code) this.pendingCodeScroll = match;
      // ProseMirror skips its default scroll when the DOM selection belongs to the find input.
      // Use the model/decorations in this pane without moving focus out of the search controls.
      const reveal = () => {
        this.scrollFrame = 0;
        if (!this.active || this.mode() !== 'visual' || this.matches[this.index] !== match || this.snapshot !== view.state.doc || !view.dom.isConnected) return;
        if (target.code && this.revealCode(match)) return;
        const scroll = view.dom.closest<HTMLElement>('.document-scroll'); if (!scroll) return;
        const hit = view.dom.querySelector<HTMLElement>('.moye-search-current');
        const block = target.code ? view.nodeDOM(target.pos - 1) : null;
        const blockTop = block instanceof HTMLElement ? block.getBoundingClientRect().top : null;
        const rect = hit?.getBoundingClientRect() || (blockTop === null ? view.coordsAtPos(selection.from, 1) : { top: blockTop, bottom: blockTop + 1 });
        const bounds = scroll.getBoundingClientRect(), top = bounds.top + scroll.clientTop, bottom = top + scroll.clientHeight;
        if (rect.top < top + 24 || rect.bottom > bottom - 24) scroll.scrollTop += (rect.top + rect.bottom - top - bottom) / 2;
      };
      reveal(); this.scrollFrame = requestAnimationFrame(reveal);
    }
  }
  navigate(direction: number) {
    if (this.pending || !this.matches.length) return;
    this.index = (this.index + direction + this.matches.length) % this.matches.length; this.decorate(); this.select(); this.status();
  }
  async replace(replacement: string, all: boolean): Promise<number> {
    if (this.pending || this.error || (all && this.truncated) || this.snapshotMode !== this.mode() || this.snapshot !== this.currentSnapshot()) return 0;
    const chosen = all ? this.matches : this.matches[this.index] ? [this.matches[this.index]] : [];
    if (!chosen.length) return 0;
    const changes: Array<{ match: SearchMatch; target: Target; text: string }> = [];
    let inserted = 0;
    for (const match of chosen) {
      const target = this.targets[match.segment], text = replacementText(replacement, match, target.text, this.options.regex);
      inserted += text.length;
      if (inserted > 16 * 1024 * 1024) { this.error = t("替换结果过大，请减少替换范围。"); this.status(); return 0; }
      changes.push({ match, target, text });
    }
    const next = all ? 0 : this.absolute(chosen[0]) + changes[0].text.length;
    if (this.mode() === 'source') this.source().dispatch({ changes: changes.map(change => ({ from: change.match.from, to: change.match.to, insert: change.text })), annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.replace')] });
    else {
      const view = this.visual(); let transaction = closeHistory(view.state.tr);
      const groups = new Map<number, typeof changes>();
      for (const change of changes) { const group = groups.get(change.target.id) || []; group.push(change); groups.set(change.target.id, group); }
      for (const group of [...groups.values()].sort((a, b) => b[0].target.pos - a[0].target.pos)) {
        const target = group[0].target; group.sort((a, b) => b.match.from - a.match.from);
        if (target.kind === 'attribute') {
          let value = target.text; for (const change of group) value = value.slice(0, change.match.from) + change.text + value.slice(change.match.to);
          transaction = transaction.setNodeAttribute(target.pos, target.attribute!, value);
        } else for (const change of group) transaction = transaction.insertText(change.text, target.pos + change.match.from, target.pos + change.match.to);
      }
      view.dispatch(transaction); view.dispatch(closeHistory(view.state.tr));
    }
    this.changed(); await this.refresh(true, next); return chosen.length;
  }
  undo() { const result = this.mode() === 'source' ? codeUndo(this.source()) : proseUndo(this.visual().state, this.visual().dispatch); if (result) this.changed(); return result; }
}

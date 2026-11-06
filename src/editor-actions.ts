import { t } from '../electron/i18n.mjs';
import { TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { Fragment, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import { wrapInList } from '@milkdown/kit/prose/schema-list';
import { undo as proseUndo, redo as proseRedo, closeHistory } from '@milkdown/kit/prose/history';
import { addColumnAfter, deleteColumn, deleteTable, selectedRect } from '@milkdown/kit/prose/tables';
import { undo as codeUndo, redo as codeRedo, isolateHistory } from '@codemirror/commands';
import type { EditorView as CodeView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { separateMetadata } from './markdown';

export interface InsertionPoint { mode: 'visual' | 'source'; doc: ProseNode | Text; from: number; to: number; identity: unknown }
export const escapeMarkdownLabel = (value: string) => value.replace(/[\\[\]`*_]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export class EditorActions {
  constructor(private visual: () => ProseView, private source: () => CodeView, private mode: () => 'visual' | 'source', private done: () => void, private addTableRow: () => boolean, private identity: () => unknown = () => null) {}
  capture(coordinates?: { x: number; y: number }): InsertionPoint {
    if (this.mode() === 'source') {
      const view = this.source(), pos = coordinates ? view.posAtCoords(coordinates) : null;
      return { mode: 'source', doc: view.state.doc, from: pos ?? view.state.selection.main.from, to: pos ?? view.state.selection.main.to, identity: this.identity() };
    }
    const view = this.visual(), pos = coordinates ? view.posAtCoords({ left: coordinates.x, top: coordinates.y })?.pos : undefined;
    return { mode: 'visual', doc: view.state.doc, from: pos ?? view.state.selection.from, to: pos ?? view.state.selection.to, identity: this.identity() };
  }
  captureImages(coordinates?: { x: number; y: number }): InsertionPoint {
    const point = this.capture(coordinates);
    // Images insert complete Markdown blocks. A drop/caret inside an existing
    // destination must not split its URL (or another token) with blank lines.
    if (point.mode === 'source' && point.from === point.to) point.from = point.to = this.source().state.doc.lineAt(point.from).to;
    return point;
  }
  isCurrent(point: InsertionPoint) { return point.identity === this.identity() && point.mode === this.mode() && point.doc === (point.mode === 'source' ? this.source().state.doc : this.visual().state.doc); }
  private restore(point: InsertionPoint) {
    if (!this.isCurrent(point)) throw new Error(t("文稿已改变，请重新选择插入位置。"));
    if (point.mode === 'source') this.source().dispatch({ selection: { anchor: point.from, head: point.to } });
    else { const view = this.visual(); view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(point.from), view.state.doc.resolve(point.to))).setMeta('addToHistory', false)); }
  }
  selectedText() {
    if (this.mode() === 'source') { const { from, to } = this.source().state.selection.main; return this.source().state.sliceDoc(from, to); }
    const { doc, selection } = this.visual().state; return doc.textBetween(selection.from, selection.to, '\n');
  }
  private sourceInsert(text: string, from?: number, to?: number) {
    const view = this.source(), selection = view.state.selection.main;
    from ??= selection.from; to ??= selection.to;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, annotations: isolateHistory.of('full'), scrollIntoView: true });
    this.done();
  }
  private apply(transaction: Transaction) {
    const view = this.visual(); view.dispatch(closeHistory(transaction).scrollIntoView()); view.dispatch(closeHistory(view.state.tr)); this.done();
  }
  images(images: Array<{ src: string; alt: string }>, point: InsertionPoint) {
    this.restore(point);
    if (point.mode === 'source') {
      const value = '\n\n' + images.map(image => `![${escapeMarkdownLabel(image.alt)}](${image.src})`).join('\n\n') + '\n\n';
      const prefix = separateMetadata(this.source().state.doc.toString()).prefix.length;
      return point.from < prefix ? this.sourceInsert(value, prefix, prefix) : this.sourceInsert(value);
    }
    const view = this.visual(), { schema } = view.state;
    const nodes = images.map(image => schema.nodes['image-block'].create({ src: image.src, alt: image.alt, caption: '', ratio: 1 }));
    nodes.push(schema.nodes.paragraph.create());
    this.apply(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)));
  }
  insert(kind: 'link' | 'footnote' | 'table', data: { text?: string; href?: string; rows?: number; cols?: number }, point: InsertionPoint) {
    this.restore(point);
    const selected = this.selectedText();
    if (kind === 'link') {
      const href = (data.href || '').trim();
      if (!href || /[\u0000-\u0020<>]/.test(href) || /^(?!https?:|mailto:)[a-z][a-z0-9+.-]*:/i.test(href)) throw new Error(t("请输入网页、邮件、相对文件地址或章节锚点。"));
      const text = data.text || selected || href;
      if (point.mode === 'source') return this.sourceInsert(`[${escapeMarkdownLabel(text)}](${href.replace(/[()]/g, c => c === '(' ? '%28' : '%29')})`);
      const view = this.visual(), mark = view.state.schema.marks.link.create({ href, title: null });
      this.apply(selected && selected === text ? view.state.tr.addMark(point.from, point.to, mark) : view.state.tr.replaceSelectionWith(view.state.schema.text(text, [mark]), false)); return;
    }
    if (kind === 'table') {
      const rows = Math.max(2, Math.min(20, data.rows || 3)), cols = Math.max(1, Math.min(12, data.cols || 3));
      if (point.mode === 'source') return this.sourceInsert('\n\n' + [`| ${Array.from({ length: cols }, (_, i) => t("列 {0}", i + 1)).join(' | ')} |`, `| ${Array(cols).fill('---').join(' | ')} |`, ...Array(rows - 1).fill(`| ${Array(cols).fill(' ').join(' | ')} |`)].join('\n') + '\n\n');
      const view = this.visual(), { schema } = view.state;
      const rowNodes = Array.from({ length: rows }, (_, r) => schema.nodes[r ? 'table_row' : 'table_header_row'].create(null, Array.from({ length: cols }, (_, c) => (r ? schema.nodes.table_cell : schema.nodes.table_header).create(null, schema.nodes.paragraph.create(null, r ? undefined : schema.text(t("列 {0}", c + 1)))))));
      this.apply(view.state.tr.replaceSelectionWith(schema.nodes.table.create(null, rowNodes))); return;
    }
    const note = data.text?.trim(); if (!note) throw new Error(t("请输入脚注内容。"));
    let label = 'note-1', index = 1;
    if (point.mode === 'source') {
      const view = this.source(), content = view.state.doc.toString();
      while (content.includes(`[^${label}]`)) label = `note-${++index}`;
      const reference = `[^${label}]`, definition = `\n\n[^${label}]: ${note.replace(/\n/g, '\n    ')}\n`;
      const from = view.state.selection.main.to;
      if (from === content.length) return this.sourceInsert(reference + definition, from, from);
      view.dispatch({ changes: [{ from, insert: reference }, { from: content.length, insert: definition }], selection: { anchor: from + reference.length }, annotations: isolateHistory.of('full') }); this.done(); return;
    }
    const view = this.visual(), { schema } = view.state, used = new Set<string>();
    view.state.doc.descendants(node => { if (node.type.name.startsWith('footnote_')) used.add(String(node.attrs.label)); });
    while (used.has(label)) label = `note-${++index}`;
    let tr = view.state.tr.insert(view.state.selection.to, schema.nodes.footnote_reference.create({ label }));
    tr = tr.insert(tr.doc.content.size, schema.nodes.footnote_definition.create({ label }, schema.nodes.paragraph.create(null, schema.text(note)))); this.apply(tr);
  }
  command(name: string) {
    if (name === 'undo' || name === 'redo') {
      const result = this.mode() === 'source' ? (name === 'undo' ? codeUndo : codeRedo)(this.source()) : (name === 'undo' ? proseUndo : proseRedo)(this.visual().state, this.visual().dispatch);
      if (result) this.done(); return result;
    }
    const selected = this.selectedText();
    if (this.mode() === 'source') {
      if (['task', 'ordered', 'quote', 'alert', 'list', 'paragraph'].includes(name) || /^h[1-6]$/.test(name)) {
        const { doc, selection } = this.source().state, { from, to } = selection.main;
        const start = doc.lineAt(from).from, end = doc.lineAt(to > from ? to - 1 : to).to;
        const lines = doc.sliceString(start, end).split('\n');
        const body = lines.map((line, index) => {
          if (/^h[1-6]$/.test(name)) return `${'#'.repeat(Number(name[1]))} ${line.replace(/^#{1,6}\s+/, '') || t("标题")}`;
          if (name === 'paragraph') return line.replace(/^#{1,6}\s+/, '');
          if (name === 'quote' || name === 'alert') return `> ${line || t("引用文字")}`;
          return `${name === 'task' ? '- [ ]' : name === 'ordered' ? `${index + 1}.` : '-'} ${line || t("列表项")}`;
        }).join('\n');
        const next = name === 'alert' ? `\n\n> [!NOTE]\n${body}\n\n` : body;
        if (next !== doc.sliceString(start, end)) this.sourceInsert(next, start, end);
        else this.source().focus();
        return true;
      }
      const snippets: Record<string, string> = {
        toc: '\n\n[TOC]\n\n',
        sub: `~${selected || t("下标")}~`, sup: `^${selected || t("上标")}^`, highlight: `==${selected || t("高亮")}==`, strike: `~~${selected || t("删除线")}~~`,
      };
      if (snippets[name] !== undefined) { this.sourceInsert(snippets[name]); return true; }
      return false;
    }
    const view = this.visual(); view.dispatch(closeHistory(view.state.tr));
    const { state } = view, { schema } = state;
    const markNames: Record<string, string> = { sub: 'meki_sub', sup: 'meki_sup', highlight: 'meki_highlight', strike: 'strike_through' };
    let result = false;
    if (markNames[name]) result = toggleMark(schema.marks[markNames[name]])(state, view.dispatch);
    else if (name === 'toc') { this.apply(state.tr.replaceSelectionWith(schema.nodes.meki_toc.create())); return true; }
    else if (name === 'alert' || name === 'quote') result = wrapIn(schema.nodes[name === 'alert' ? 'meki_alert' : 'blockquote'], name === 'alert' ? { kind: 'note' } : undefined)(state, view.dispatch);
    else if (name === 'task' || name === 'ordered') {
      result = wrapInList(schema.nodes[name === 'task' ? 'bullet_list' : 'ordered_list'])(state, view.dispatch);
      if (name === 'task') {
        const next = view.state; let tr = next.tr;
        next.doc.nodesBetween(next.selection.from, next.selection.to, (node, pos) => { if (node.type.name === 'list_item') tr = tr.setNodeAttribute(pos, 'checked', false); });
        if (tr.docChanged) { view.dispatch(tr); result = true; }
      }
    } else if (name.startsWith('table-')) {
      const command = ({ 'table-col': addColumnAfter, 'table-delete-col': deleteColumn } as Record<string, typeof addColumnAfter>)[name];
      if (name === 'table-row') result = this.addTableRow();
      else if (name === 'table-delete-row' && this.inTable()) {
        const rect = selectedRect(state), rows: ProseNode[] = [];
        rect.table.forEach((row, _offset, index) => { if (index < rect.top || index >= rect.bottom) rows.push(row); });
        if (!rows.length) result = deleteTable(state, view.dispatch);
        else {
          const normalized = rows.map((row, index) => (index ? schema.nodes.table_row : schema.nodes.table_header_row).create(null,
            Array.from({ length: row.childCount }, (_, col) => (index ? schema.nodes.table_cell : schema.nodes.table_header).create(row.child(col).attrs, row.child(col).content))));
          if (normalized.length === 1) normalized.push(schema.nodes.table_row.create(null, Array.from({ length: rect.map.width }, (_, col) => schema.nodes.table_cell.createAndFill({ alignment: normalized[0].child(col).attrs.alignment })!)));
          const tr = state.tr.replaceWith(rect.tableStart - 1, rect.tableStart - 1 + rect.table.nodeSize, schema.nodes.table.create(rect.table.attrs, normalized));
          tr.setSelection(TextSelection.near(tr.doc.resolve(rect.tableStart + 2))); this.apply(tr); return true;
        }
      }
      else if (command) result = command(state, view.dispatch);
      else if (name.startsWith('table-align-') && this.inTable()) {
        const rect = selectedRect(state), positions = new Set<number>(); let tr = state.tr;
        for (let row = 0; row < rect.map.height; row++) for (let col = rect.left; col < rect.right; col++) positions.add(rect.tableStart + rect.map.map[row * rect.map.width + col]);
        for (const pos of positions) tr = tr.setNodeAttribute(pos, 'alignment', name.slice(12));
        this.apply(tr); return true;
      }
    }
    if (result) { view.dispatch(closeHistory(view.state.tr)); this.done(); } return result;
  }
  inTable() { return this.mode() === 'visual' && Array.from({ length: this.visual().state.selection.$from.depth }, (_, i) => this.visual().state.selection.$from.node(i + 1)).some(node => node.type.name === 'table'); }
  syncImageAlt() { const view = this.visual(); view.state.doc.descendants((node, pos) => { if (node.type.name === 'image-block') { const element = view.nodeDOM(pos); if (element instanceof HTMLElement) { const image = element.querySelector('img'); if (image) image.alt = String(node.attrs.alt || ''); } } }); }
}

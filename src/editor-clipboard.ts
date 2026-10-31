import { t } from '../electron/i18n.mjs';
import { Fragment, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { closeHistory } from '@milkdown/kit/prose/history';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { EditorView as CodeView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import type { EditorActions } from './editor-actions';

export type ClipboardCommand = 'copy-text' | 'copy-markdown' | 'paste-text' | 'paste-markdown';
export const clipboardCommands = new Set<string>(['copy-text', 'copy-markdown', 'paste-text', 'paste-markdown']);
export class EditorClipboard {
  private pending = false;
  constructor(private visual: () => ProseView, private source: () => CodeView, private mode: () => 'visual' | 'source',
    private actions: EditorActions, private parse: (text: string) => ProseNode | null | undefined,
    private serialize: (doc: ProseNode) => string, private done: () => void) {}

  async execute(command: ClipboardCommand): Promise<string> {
    if (this.pending) return '';
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return this.input(command, focused);
    if (command.startsWith('copy-')) {
      const text = this.selected(command === 'copy-markdown');
      if (!text) return t("请先选中要复制的内容。");
      await window.moye.writeClipboardText(text);
      return command === 'copy-text' ? t("已复制为纯文本") : t("已复制为 Markdown");
    }
    const point = this.actions.capture();
    const selected = point.mode === 'visual' ? this.visual().state.selection : null;
    this.pending = true;
    try {
      // Explicit paste reads only text/plain. HTML and VS Code metadata never enter Milkdown's paste plugin.
      const text = await window.moye.readClipboardText();
      if (!this.actions.isCurrent(point)) throw new Error(t("读取剪贴板期间文稿已改变，请重新粘贴。"));
      if (!text) return t("剪贴板中没有文本。");
      if (point.mode === 'source') {
        const view = this.source();
        view.dispatch({ changes: { from: point.from, to: point.to, insert: text }, selection: { anchor: point.from + view.state.toText(text).length }, annotations: isolateHistory.of('full'), scrollIntoView: true });
      } else {
        const view = this.visual(), { state } = view;
        const selection = selected!;
        let transaction = state.tr.setSelection(selection);
        if (selection.$from.parent.type.spec.code) transaction = transaction.insertText(text.replace(/\r\n?/g, '\n'));
        else {
          let slice: Slice;
          if (command === 'paste-markdown') {
            const parsed = this.parse(text);
            if (!parsed) throw new Error(t("无法解析剪贴板中的 Markdown。"));
            slice = Slice.maxOpen(parsed.content);
          } else {
            const paragraphs = text.split(/\r\n?|\n/).map(line => state.schema.nodes.paragraph.create(null, line ? state.schema.text(line) : undefined));
            slice = new Slice(Fragment.from(paragraphs), 1, 1);
          }
          transaction = transaction.replaceSelection(slice);
        }
        view.dispatch(closeHistory(transaction.setMeta('moye-preserve-code-language', true)).scrollIntoView());
        view.dispatch(closeHistory(view.state.tr));
      }
      this.done();
      return command === 'paste-text' ? t("已粘贴纯文本") : t("已粘贴 Markdown");
    } finally { this.pending = false; }
  }
  private async input(command: ClipboardCommand, field: HTMLInputElement | HTMLTextAreaElement): Promise<string> {
    const from = field.selectionStart, to = field.selectionEnd;
    if (from === null || to === null || field.disabled) return '';
    const value = field.value;
    if (command.startsWith('copy-')) {
      if (from === to) return t("请先选中要复制的内容。");
      await window.moye.writeClipboardText(value.slice(from, to)); return t("已复制文本");
    }
    if (field.readOnly) return '';
    this.pending = true;
    try {
      const text = await window.moye.readClipboardText();
      if (!field.isConnected || field !== document.activeElement || value !== field.value) throw new Error(t("读取剪贴板期间输入框已改变，请重新粘贴。"));
      if (!text) return t("剪贴板中没有文本。");
      field.setRangeText(text, from, to, 'end');
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      return t("已粘贴文本");
    } finally { this.pending = false; }
  }
  private selected(markdown: boolean): string {
    if (this.mode() === 'source') { const view = this.source(); return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); }
    const { state } = this.visual();
    if (state.selection.empty) return '';
    if (!markdown) return state.doc.textBetween(state.selection.from, state.selection.to, '\n', node => String(node.attrs.value || node.attrs.alt || node.attrs.label || ''));
    const slice = state.selection.content();
    const doc = state.schema.topNodeType.createAndFill(undefined, slice.content);
    if (!doc) throw new Error(t("无法复制当前选区的 Markdown。"));
    return this.serialize(doc);
  }
}

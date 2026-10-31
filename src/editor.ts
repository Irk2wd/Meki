import { t } from '../electron/i18n.mjs';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import { imageBlockSchema, imageBlockView } from '@milkdown/kit/component/image-block';
import { tableBlockView } from '@milkdown/kit/component/table-block';
import { blockService } from '@milkdown/kit/plugin/block';
import { remarkGFMPlugin, strikethroughInputRule, addRowAfterCommand } from '@milkdown/kit/preset/gfm';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand, wrapInBulletListCommand, createCodeBlockCommand } from '@milkdown/kit/preset/commonmark';
import { type EditorState as RichState } from '@milkdown/kit/prose/state';
import { setBlockType } from '@milkdown/kit/prose/commands';
import { closeHistory } from '@milkdown/kit/prose/history';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import { languages } from '@codemirror/language-data';
import { separateMetadata } from './markdown';
import { markdownEditorExtensions, setHeadingNumbering } from './editor-extensions';
import { EditorMath } from './editor-math';
import { EditorDiagrams } from './editor-diagrams';
import { EditorSearch } from './editor-search';
import { EditorWriting } from './editor-writing';
import { EditorTyping } from './editor-typing';
import { EditorActions } from './editor-actions';
import { stableTableBlockView } from './editor-table';
import { EditorCode } from './editor-code';
import { EditorClipboard } from './editor-clipboard';
import { sizedImageBlockView } from './editor-images';
import { imageDimension, imageTag, parseImageTag, safeImageSource } from './image-syntax';
import { applyMarkdownEdits, type MarkdownEdit } from './attachment-markdown';
import { FrameBlockService, blockHandlePosition, blockInsertMenu } from './editor-block-handle';
import type { Settings } from '../shared/moye';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import 'katex/dist/katex.min.css';
import './markdown-extensions.css';
import './diagrams.css';
import './editor-block-handle.css';
import './editor-lists.css';

export interface EditorSnapshot {
  rich: RichState; source: EditorState; mode: 'visual' | 'source';
  metadata: string; serialized: string; visualContent: string; sourceScroll: number;
}

export class WritingEditor {
  crepe: Crepe;
  source: EditorView;
  mode: 'visual' | 'source' = 'visual';
  private lastSerialized = '';
  private metadata = '';
  private updating = false;
  private ready = false;
  private documentGeneration = 0;
  private headingNumbering = false;
  private visualContent = '';
  private math = new EditorMath();
  private diagrams = new EditorDiagrams();
  private blocks = new FrameBlockService(() => this.flush());
  readonly search = new EditorSearch(() => this.crepe.editor.action(ctx => ctx.get(editorViewCtx)), () => this.source, () => this.mode, () => this.flush());
  readonly writing = new EditorWriting(() => this.crepe.editor.action(ctx => ctx.get(editorViewCtx)), () => this.source, () => this.mode);
  readonly typing = new EditorTyping(() => this.source);
  readonly code = new EditorCode();
  uploadImage: (file: File) => Promise<string> = async () => '';
  imageSourceAt(target: HTMLElement): string | null {
    if (!target.closest('.ProseMirror')) return null;
    return this.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      try {
        const position = view.posAtDOM(target, 0), resolved = view.state.doc.resolve(position);
        const candidates = [view.state.doc.nodeAt(position), resolved.nodeAfter, resolved.nodeBefore, resolved.parent];
        return candidates.find(node => node && ['image', 'image-block'].includes(node.type.name) && typeof node.attrs.src === 'string')?.attrs.src || null;
        } catch { return null; }
    });
  }
  readonly actions = new EditorActions(() => this.crepe.editor.action(ctx => ctx.get(editorViewCtx)), () => this.source, () => this.mode, () => { this.flush(); this.focus(); }, () => this.crepe.editor.action(callCommand(addRowAfterCommand.key)), () => this.documentGeneration);
  readonly clipboard = new EditorClipboard(() => this.crepe.editor.action(ctx => ctx.get(editorViewCtx)), () => this.source, () => this.mode, this.actions,
    text => this.crepe.editor.action(ctx => ctx.get(parserCtx)(text)), doc => this.crepe.editor.action(ctx => ctx.get(serializerCtx)(doc)), () => { this.flush(); this.focus(); });

  constructor(private visualHost: HTMLElement, private sourceHost: HTMLElement,
    private onChange: (markdown: string) => void,
    getPath: () => string | null, onError: (message: string) => void) {
    const upload = (file: File) => this.uploadImage(file);
    this.crepe = new Crepe({ root: visualHost, defaultValue: '',
      features: { [Crepe.Feature.Toolbar]: false, [Crepe.Feature.TopBar]: false, [Crepe.Feature.AI]: false },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: t("写下这一页的第一句话…") },
        [Crepe.Feature.CodeMirror]: { languages, theme: this.code.theme, extensions: [this.code.extension, this.search.codeExtension], previewOnlyByDefault: true, previewLabel: t("预览"), previewLoading: t("渲染中…"), previewToggleText: preview => preview ? t("编辑源码") : t("收起源码"), copyText: t("复制"), searchPlaceholder: t("搜索语言"), noResultText: t("没有匹配的语言") },
        [Crepe.Feature.ImageBlock]: { onUpload: upload, inlineOnUpload: upload, blockOnUpload: upload,
          proxyDomURL: (url) => window.moye.assetUrl(url, getPath()),
          inlineUploadPlaceholderText: t("图片地址"), blockUploadPlaceholderText: t("图片地址或上传本地图片"), blockCaptionPlaceholderText: t("添加图片说明") },
        [Crepe.Feature.LinkTooltip]: { inputPlaceholder: t("粘贴链接地址") },
        [Crepe.Feature.BlockEdit]: {
          blockHandle: { getPosition: blockHandlePosition, getPlacement: () => 'left', floatingUIOptions: { middleware: [] } },
          slashMenu: { floatingUIOptions: { middleware: blockInsertMenu(visualHost.closest<HTMLElement>('.document-scroll') || visualHost) } },
          textGroup: { label: t("文本"), text: { label: t("正文") }, h1: { label: t("一级标题") }, h2: { label: t("二级标题") }, h3: { label: t("三级标题") }, h4: { label: t("四级标题") }, h5: { label: t("五级标题") }, h6: { label: t("六级标题") }, quote: { label: t("引用") }, divider: { label: t("分隔线") } },
          listGroup: { label: t("列表"), bulletList: { label: t("无序列表") }, orderedList: { label: t("有序列表") }, taskList: { label: t("待办清单") } },
          advancedGroup: { label: t("插入"), image: { label: t("图片") }, codeBlock: { label: t("代码块") }, table: { label: t("表格") }, math: { label: t("数学公式") } },
        },
        [Crepe.Feature.Latex]: { katexOptions: { throwOnError: false, trust: false, strict: 'ignore' } },
      },
    });
    this.crepe.editor.config(ctx => {
      ctx.set(blockService.key, () => this.blocks);
      ctx.set(remarkGFMPlugin.options.key, { singleTilde: false });
      // Pixel dimensions are separate from alt/title and survive the Markdown and clipboard paths.
      ctx.update(imageBlockSchema.key, previous => ctx => ({
        ...previous(ctx),
        attrs: { ...previous(ctx).attrs, alt: { default: '', validate: 'string' }, width: { default: null, validate: 'number|null' }, height: { default: null, validate: 'number|null' } },
        parseDOM: [{ tag: 'img[data-type="image-block"]', getAttrs: dom => {
          const src = dom.getAttribute('src') || ''; if (!safeImageSource(src)) return false;
          return { src, alt: dom.getAttribute('alt') || '', caption: dom.getAttribute('title') || dom.getAttribute('caption') || '', ratio: 1, width: imageDimension(Number(dom.getAttribute('width'))), height: imageDimension(Number(dom.getAttribute('height'))) };
        } }],
        toDOM: node => ['img', { 'data-type': 'image-block', src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.caption || null, width: imageDimension(node.attrs.width), height: imageDimension(node.attrs.height) }],
        parseMarkdown: { match: node => node.type === 'image-block' || node.type === 'moyeImage', runner: (state, node, type) => {
          const image = node.type === 'moyeImage' ? parseImageTag(String(node.value))! : null;
          state.addNode(type, { src: image?.src ?? node.url, caption: image?.title ?? node.title ?? '', alt: image?.alt ?? node.alt ?? '', ratio: 1, width: image?.width ?? null, height: image?.height ?? null });
        } },
        toMarkdown: { match: node => node.type.name === 'image-block', runner: (state, node) => {
          const image = { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.caption || null, width: imageDimension(node.attrs.width), height: imageDimension(node.attrs.height) };
          if (image.width || image.height) state.addNode('moyeImage', undefined, imageTag(image));
          else state.openNode('paragraph').addNode('image', undefined, undefined, { title: image.title, url: image.src, alt: image.alt }).closeNode();
        } },
      }));
      ctx.update(codeBlockConfig.key, config => ({ ...config, renderPreview: (language, content, apply) => language.toLowerCase() === 'latex' ? this.math.blockPreview(content) : language.toLowerCase() === 'mermaid' ? this.diagrams.blockPreview(content) : config.renderPreview(language, content, apply) }));
    }).use(markdownEditorExtensions).use(this.math.plugin).use(this.diagrams.plugin).use(this.search.plugin).use(this.writing.plugin).use(this.typing.plugin).use(stableTableBlockView).use(this.code.plugin).use(sizedImageBlockView).use(this.blocks.plugin);
    this.crepe.on(listener => {
      listener.markdownUpdated((_ctx, value) => {
        if (!this.ready || this.updating || value === this.lastSerialized || this.mode !== 'visual' || value !== this.crepe.getMarkdown()) return;
        this.lastSerialized = value;
        this.onChange(this.metadata + value);
      });
    });
    this.source = new EditorView({ parent: sourceHost, state: this.sourceState('') });
  }

  private sourceState(content: string) {
    return EditorState.create({ doc: content, extensions: [basicSetup, markdown(), EditorView.lineWrapping, this.search.sourceExtension, this.writing.sourceConfig, this.typing.sourceExtension,
      keymap.of(searchKeymap), EditorView.contentAttributes.of({ 'aria-label': t("Markdown 源码编辑区"), spellcheck: 'false' }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !this.updating && this.mode === 'source') { this.onChange(update.state.doc.toString()); this.search.documentChanged(); }
        if (!this.updating && this.mode === 'source' && (update.docChanged || update.selectionSet)) this.writing.updated();
      }),
      EditorView.theme({ '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' }, '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '15px', lineHeight: '1.85' }, '.cm-content': { padding: '32px 28px 100px' }, '.cm-gutters': { background: 'transparent', color: 'var(--muted)', border: 'none' }, '.cm-activeLine': { background: 'var(--hover)' }, '.cm-activeLineGutter': { background: 'var(--hover)' }, '.cm-cursor': { borderLeftColor: 'var(--accent)' }, '.cm-selectionBackground': { background: 'var(--selection) !important' }, '.cm-focused': { outline: 'none' } }),
    ] });
  }

  async create() { await this.crepe.editor.remove([strikethroughInputRule, tableBlockView, imageBlockView]); await this.crepe.create(); this.ready = true; this.lastSerialized = this.crepe.getMarkdown(); }
  cancelPendingActions() { this.documentGeneration++; this.blocks.cancel(); }
  async destroy() { this.cancelPendingActions(); this.search.close(); this.source.destroy(); await this.crepe.destroy(); }
  updateSettings(settings: Settings) { this.math.updateSettings(settings); this.diagrams.updateSettings(settings); this.writing.updateSettings(settings); this.typing.updateSettings(settings); this.code.updateSettings(settings); this.headingNumbering = settings.headingNumbering === true; if (this.ready) this.crepe.editor.action(ctx => setHeadingNumbering(ctx.get(editorViewCtx), this.headingNumbering)); }
  async preparePrint() { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); this.math.flush(); await this.diagrams.flush(); }
  flush() {
    this.math.flush();
    if (this.mode === 'source') { this.onChange(this.source.state.doc.toString()); return; }
    const value = this.crepe.getMarkdown();
    if (value !== this.lastSerialized) { this.lastSerialized = value; this.onChange(this.metadata + value); }
  }
  load(content: string) {
    this.cancelPendingActions();
    this.updating = true; this.code.loading = true;
    const { prefix, body } = separateMetadata(content);
    this.metadata = prefix;
    this.crepe.editor.action(replaceAll(body, true));
    this.crepe.editor.action(ctx => setHeadingNumbering(ctx.get(editorViewCtx), this.headingNumbering));
    this.lastSerialized = this.crepe.getMarkdown();
    this.source.setState(this.sourceState(content));
    this.visualContent = content;
    this.updating = false; this.code.loading = false;
    this.search.documentSwitched(); this.writing.updated();
  }
  snapshot(): EditorSnapshot {
    this.flush();
    return { rich: this.crepe.editor.action(ctx => ctx.get(editorViewCtx).state), source: this.source.state,
      mode: this.mode, metadata: this.metadata, serialized: this.lastSerialized, visualContent: this.visualContent,
      sourceScroll: this.source.scrollDOM.scrollTop };
  }
  restore(snapshot: EditorSnapshot) {
    this.cancelPendingActions();
    this.updating = true; this.code.loading = true;
    this.mode = snapshot.mode; this.metadata = snapshot.metadata;
    this.lastSerialized = snapshot.serialized; this.visualContent = snapshot.visualContent;
    this.crepe.editor.action(ctx => ctx.get(editorViewCtx).updateState(snapshot.rich));
    this.source.setState(snapshot.source);
    this.typing.sourceRestored();
    this.source.scrollDOM.scrollTop = snapshot.sourceScroll;
    this.visualHost.hidden = this.mode === 'source'; this.sourceHost.hidden = this.mode === 'visual';
    this.updating = false; this.code.loading = false;
    this.search.documentSwitched(); this.writing.updated();
  }
  setMode(mode: 'visual' | 'source', content: string) {
    this.blocks.cancel();
    this.updating = true; this.code.loading = true;
    if (mode === 'source') {
      this.visualContent = content;
      const cursor = Math.min(this.source.state.selection.main.head, content.length);
      if (this.source.state.doc.toString() !== content) this.source.dispatch({ changes: { from: 0, to: this.source.state.doc.length, insert: content }, selection: { anchor: cursor } });
    } else {
      const { prefix, body } = separateMetadata(content);
      this.metadata = prefix;
      if (content !== this.visualContent) {
        this.crepe.editor.action(ctx => { const view = ctx.get(editorViewCtx); view.dispatch(closeHistory(view.state.tr)); });
        this.crepe.editor.action(replaceAll(body));
        this.crepe.editor.action(ctx => { const view = ctx.get(editorViewCtx); view.dispatch(closeHistory(view.state.tr)); });
      }
      this.lastSerialized = this.crepe.getMarkdown();
    }
    this.mode = mode;
    this.visualHost.hidden = mode === 'source';
    this.sourceHost.hidden = mode === 'visual';
    this.updating = false; this.code.loading = false;
    this.search.modeChanged(); this.writing.updated();
    const previousFocus = document.activeElement, generation = this.documentGeneration;
    requestAnimationFrame(() => {
      // A user may reach a caption or another input before this frame runs.
      // Only restore default focus while the mode, document and target are still current.
      if (this.mode === mode && this.documentGeneration === generation &&
        (document.activeElement === previousFocus || document.activeElement === document.body)) this.focus();
    });
  }
  focus() { if (this.mode === 'source') this.source.focus(); else this.crepe.editor.action(ctx => ctx.get(editorViewCtx).focus()); }
  replaceMarkdownRanges(content: string, changes: MarkdownEdit[]) {
    const next = applyMarkdownEdits(content, changes), original = this.snapshot(), mode = this.mode;
    try {
      if (mode === 'visual') this.setMode('source', content);
      // CodeMirror offsets use LF even when the untouched disk snapshot contains CRLF.
      const normalized = content.replace(/\r\n?/g, '\n');
      if (this.source.state.doc.toString() !== normalized) throw new Error(t("编辑内容已变化，请重新整理。"));
      const offset = (index: number) => content.slice(0, index).replace(/\r\n/g, '\n').length;
      this.source.dispatch({ changes: changes.map(change => ({ from: offset(change.from), to: offset(change.to), insert: change.insert })), annotations: isolateHistory.of('full') });
      if (mode === 'visual') { this.setMode('visual', next); this.onChange(next); }
    } catch (error) { this.restore(original); this.onChange(content); throw error; }
  }
  insertMarkdown(value: string, inline = false) {
    if (this.mode === 'source') {
      const { from, to } = this.source.state.selection.main;
      this.source.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from + value.length } });
    } else this.crepe.editor.action(insert(value, inline));
    this.focus();
  }
  format(command: string) {
    if (this.mode === 'source') {
      if (/^h[1-6]$/.test(command) || command === 'paragraph' || command === 'list') { this.actions.command(command); return; }
      const { from, to } = this.source.state.selection.main;
      const selected = this.source.state.sliceDoc(from, to);
      const snippets: Record<string, string> = { bold: `**${selected || t("粗体")}**`, italic: `*${selected || t("斜体")}*`, code: `\n\`\`\`${this.code.language()}\n${selected}\n\`\`\`\n` };
      this.insertMarkdown(snippets[command] || ''); return;
    }
    if (command === 'bold') this.crepe.editor.action(callCommand(toggleStrongCommand.key));
    if (command === 'italic') this.crepe.editor.action(callCommand(toggleEmphasisCommand.key));
    if (/^h[1-6]$/.test(command)) this.crepe.editor.action(callCommand(wrapInHeadingCommand.key, Number(command[1])));
    if (command === 'list') this.crepe.editor.action(callCommand(wrapInBulletListCommand.key));
    if (command === 'code') this.crepe.editor.action(callCommand(createCodeBlockCommand.key, this.code.language()));
    if (command === 'paragraph') this.crepe.editor.action(ctx => { const view = ctx.get(editorViewCtx); setBlockType(view.state.schema.nodes.paragraph)(view.state, view.dispatch); });
    this.focus();
  }
  goToHeading(index: number, sourceOffset: number) {
    if (this.mode === 'source') { this.source.dispatch({ selection: { anchor: sourceOffset }, scrollIntoView: true }); this.source.focus(); }
    else this.visualHost.querySelectorAll('h1,h2,h3,h4,h5,h6')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  goToLine(line: number, column = 1) {
    const target = this.source.state.doc.line(Math.max(1,Math.min(this.source.state.doc.lines,Math.floor(line))));
    const anchor = Math.min(target.to,target.from + Math.max(0,Math.floor(column)-1));
    this.source.dispatch({selection:{anchor},scrollIntoView:true}); this.source.focus();
  }
  activeHeading(entries: Array<{ offset: number }>) {
    if (this.mode === 'source') {
      const scroll = this.source.scrollDOM;
      if (scroll.scrollHeight > scroll.clientHeight + 2 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 3) return entries.length - 1;
      const area = this.source.scrollDOM.getBoundingClientRect();
      const position = this.source.posAtCoords({ x: area.left + area.width / 2, y: area.top + Math.min(70, area.height / 4) }) ?? this.source.state.selection.main.head;
      return Math.max(0, entries.findLastIndex(entry => entry.offset <= position));
    }
    const scroll = this.visualHost.closest('.document-scroll')!;
    if (scroll.scrollHeight > scroll.clientHeight + 2 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 3) return entries.length - 1;
    const top = scroll.getBoundingClientRect().top + 70;
    return Math.max(0, [...this.visualHost.querySelectorAll('h1,h2,h3,h4,h5,h6')].findLastIndex(heading => heading.getBoundingClientRect().top <= top));
  }
}

import type { Ctx } from '@milkdown/kit/ctx';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { BlockService, blockConfig, type ActiveNode, type BlockServiceMessage, type DeriveContext } from '@milkdown/kit/plugin/block';
import { NodeSelection, Plugin, PluginKey, Selection, type Command, type Transaction } from '@milkdown/kit/prose/state';
import { closeHistory } from '@milkdown/kit/prose/history';
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { $prose } from '@milkdown/kit/utils';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { flip, offset, shift, size } from '@floating-ui/dom';
import { t } from '../electron/i18n.mjs';
import { countWords } from './search';
import { BlockMenu, type BlockAction } from './editor-block-menu';
import { BlockDrag } from './editor-block-drag';
import { blockDocument, blockPlainText, captureBlock, convertBlock, currentBlock, deleteBlock, duplicateBlock, insertNearBlock, moveBlock, siblingDestination, styleBlock, type BlockTarget, type BlockType, type BlockMove } from './editor-block-model';

function blockLabel(target: BlockTarget) {
  const name = target.node.type.name;
  if (name === 'heading') return t('标题 {0}', target.node.attrs.level);
  if (name === 'list_item') return typeof target.node.attrs.checked === 'boolean' ? t('待办清单') : target.doc.resolve(target.pos).parent.type.name === 'ordered_list' ? t('有序列表') : t('无序列表');
  const labels: Record<string, string> = { paragraph: t('正文'), blockquote: t('引用'), code_block: t('代码块'), table: t('表格'), 'image-block': t('图片'), hr: t('分隔线'), bullet_list: t('无序列表'), ordered_list: t('有序列表') };
  return labels[name] || t('内容块');
}

export function blockInsertMenu(boundary: HTMLElement) {
  return [offset(8), flip({ boundary, padding: 8 }), size({
    boundary, padding: 8,
    apply({ availableHeight, availableWidth, elements }) {
      elements.floating.style.setProperty('--moye-menu-height', `${Math.max(0, Math.min(480, availableHeight))}px`);
      elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
    },
  }), shift({ boundary, padding: 8, crossAxis: true })];
}

// Anchor the gutter to the first rendered line, including wrapped headings and lists.
export function blockHandlePosition({ active, editorDom }: DeriveContext): DOMRect {
  const element = active.el;
  const textBlock = element.matches('p,h1,h2,h3,h4,h5,h6') ? element
    : element.querySelector<HTMLElement>('p,h1,h2,h3,h4,h5,h6,.cm-line') || element;
  const walker = document.createTreeWalker(textBlock, NodeFilter.SHOW_TEXT);
  let text: Node | null;
  while ((text = walker.nextNode())) {
    const start = text.textContent?.search(/\S/) ?? -1;
    if (start < 0 || text.parentElement?.closest('svg,button,[contenteditable="false"]')) continue;
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 1);
    const rect = range.getBoundingClientRect();
    if (rect.height) return new DOMRect(editorDom.getBoundingClientRect().left - 6, rect.top, 0, rect.height);
  }
  const rect = textBlock.getBoundingClientRect(), style = getComputedStyle(textBlock);
  const line = Math.min(rect.height, parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 24);
  return new DOMRect(editorDom.getBoundingClientRect().left - 6, rect.top + (parseFloat(style.paddingTop) || 0), 0, line);
}

// Crepe exposes a service factory. Keep its handle/menu/provider, but own hover
// scheduling and the drag selection so the displayed block is always the action target.
export class FrameBlockService extends BlockService {
  private context?: Ctx;
  private notify?: BlockServiceMessage;
  private host?: HTMLElement;
  private scroll?: HTMLElement;
  private observer?: ResizeObserver;
  private active: ActiveNode | null = null;
  private pointer: { x: number; y: number } | null = null;
  private frame = 0;
  private captured: BlockTarget | null = null;
  private menu: BlockMenu | null = null;
  private hint: { target: BlockTarget; kind: string } | null = null;
  private hintTimer = 0;
  private hintKey = new PluginKey<DecorationSet>('moye-block-hint');
  private drag: BlockDrag | null = null;
  private suppressClick = false;
  private get view() { return this.context?.get(editorViewCtx); }
  constructor(private changed: () => void = () => {}) { super(); }
  readonly plugin = $prose(() => new Plugin({ key: this.hintKey,
    state: { init: () => DecorationSet.empty, apply: (tr, previous) => {
      const hint = tr.getMeta(this.hintKey);
      if (hint !== undefined) return hint ? DecorationSet.create(tr.doc, [Decoration.node(hint.target.pos, hint.target.pos + hint.target.node.nodeSize, { class: hint.kind })]) : DecorationSet.empty;
      return tr.docChanged ? DecorationSet.empty : previous;
    } },
    props: { decorations: state => this.hintKey.getState(state) },
    view: () => ({ update: (view, previous) => {
    if (view.state.doc !== previous.doc) this.cancel();
  } }) }));
  cancel = () => { this.menu?.close(false); this.drag?.cancel(); this.highlight(null); this.captured = null; this.hide(); };
  private highlight = (target: BlockTarget | null, kind = '', duration = 0) => {
    window.clearTimeout(this.hintTimer);
    const view = this.view;
    if (!view) return;
    this.hint = target && currentBlock(view.state, target) ? { target, kind } : null;
    if (this.hint || this.hintKey.getState(view.state)?.find().length)
      view.dispatch(view.state.tr.setMeta(this.hintKey, this.hint).setMeta('addToHistory', false));
    const hint = this.hint;
    if (duration) this.hintTimer = window.setTimeout(() => { if (this.hint === hint) this.highlight(null); }, duration);
  };

  override bind = (ctx: Ctx, notify: BlockServiceMessage) => {
    if (this.context) this.unBind();
    this.context = ctx; this.notify = notify;
    const view = ctx.get(editorViewCtx);
    this.host = view.dom.closest<HTMLElement>('.editor-host') || view.dom.parentElement!;
    this.scroll = view.dom.closest<HTMLElement>('.document-scroll') || this.host;
    this.host.addEventListener('pointermove', this.pointerMove);
    this.host.addEventListener('pointerleave', this.pointerLeave);
    this.scroll.addEventListener('scroll', this.schedule, { passive: true });
    this.scroll.addEventListener('scroll', this.closeMenu, { passive: true });
    this.observer = new ResizeObserver(this.schedule); this.observer.observe(view.dom);
    window.addEventListener('resize', this.schedule);
  };
  override unBind = () => {
    this.cancel(); this.notify = undefined;
    this.host?.removeEventListener('pointermove', this.pointerMove);
    this.host?.removeEventListener('pointerleave', this.pointerLeave);
    this.scroll?.removeEventListener('scroll', this.schedule);
    this.scroll?.removeEventListener('scroll', this.closeMenu);
    this.observer?.disconnect(); window.removeEventListener('resize', this.schedule);
    this.context = undefined;
  };
  private hide = () => {
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.active = null; this.pointer = null; this.notify?.({ type: 'hide' });
  };
  private closeMenu = () => this.menu?.close(false);
  private pointerLeave = () => { if (!this.drag?.active && !this.menu) this.hide(); };
  private pointerMove = (event: PointerEvent) => { const view = this.view; if (view) this.mousemoveCallback(view, event); };
  private schedule = () => {
    if (!this.frame && this.pointer && !this.drag?.active && !this.menu) this.frame = requestAnimationFrame(() => {
      this.frame = 0; this.refresh();
    });
  };
  override mousemoveCallback = (view: EditorView, event: MouseEvent) => {
    if (view.composing || !view.editable || event.buttons || this.drag?.active || this.menu) return false;
    const target = event.target instanceof Element ? event.target : null;
    // Moving onto the buttons must not change the block they are about to act on.
    if (target?.closest('.milkdown-block-handle')) { cancelAnimationFrame(this.frame); this.frame = 0; return false; }
    if (target?.closest('.milkdown-slash-menu,.milkdown-toolbar,.milkdown-link-tooltip')) { this.hide(); return false; }
    this.pointer = { x: event.clientX, y: event.clientY }; this.schedule(); return false;
  };

  private refresh() {
    const view = this.view, point = this.pointer;
    if (!view || !point || !view.editable || view.composing || this.drag?.active || this.menu) return;
    const rect = view.dom.getBoundingClientRect(), viewport = this.scroll!.getBoundingClientRect();
    if (!rect.width || point.y < Math.max(viewport.top, rect.top) || point.y > Math.min(viewport.bottom, rect.bottom)
      || point.x < rect.left - 60 || point.x > rect.right) { this.hide(); return; }

    // Margins are part of the hover corridor: choose the nearest block instead
    // of briefly hiding the controls between adjacent paragraphs.
    const children = view.dom.children;
    let low = 0, high = children.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (children[mid].getBoundingClientRect().bottom < point.y) low = mid + 1; else high = mid;
    }
    let element = children[Math.min(low, children.length - 1)] as HTMLElement;
    if (!element) { this.hide(); return; }
    let bounds = element.getBoundingClientRect();
    if (low > 0 && point.y < bounds.top) {
      const previous = children[low - 1] as HTMLElement, previousRect = previous.getBoundingClientRect();
      if (point.y - previousRect.bottom <= bounds.top - point.y) { element = previous; bounds = previousRect; }
    }
    const y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, point.y));
    const hit = view.posAtCoords({ left: rect.left + rect.width / 2, top: y });
    if (!hit) { this.hide(); return; }
    const $hit = view.state.doc.resolve(hit.pos);
    let depth = $hit.depth;
    // A list item's paragraph belongs to the item; tables and quotes are handled
    // as complete blocks through Crepe's configured filter.
    if (depth > 1 && $hit.node(depth - 1).type.name === 'list_item') depth--;
    let active: ActiveNode | null = null;
    for (; depth > 0; depth--) {
      const pos = $hit.before(depth), node = $hit.node(depth), $pos = view.state.doc.resolve(pos);
      const el = view.nodeDOM(pos);
      if (node.isBlock && el instanceof HTMLElement && this.context!.get(blockConfig.key).filterNodes($pos, node)) {
        active = { node, $pos, el }; break;
      }
    }
    // Leaf nodes (images, horizontal rules) can resolve at their outer boundary.
    if (!active) {
      view.state.doc.forEach((node, pos) => { if (view.nodeDOM(pos) === element) active = { node, $pos: view.state.doc.resolve(pos), el: element }; });
    }
    if (!active) { this.hide(); return; }
    this.active = active; this.notify?.({ type: 'show', active });
  }

  override addEvent = (dom: HTMLElement) => {
    const add = dom.firstElementChild as HTMLElement, grip = dom.lastElementChild as HTMLElement;
    add.setAttribute('role', 'button'); add.tabIndex = 0; add.title = t('在下方插入块'); add.setAttribute('aria-label', add.title);
    grip.setAttribute('draggable', 'true'); grip.setAttribute('role', 'button'); grip.tabIndex = 0;
    grip.title = t('点击打开块菜单，拖动调整位置'); grip.setAttribute('aria-label', t('块操作')); grip.setAttribute('aria-haspopup', 'dialog'); grip.setAttribute('aria-expanded', 'false');
    dom.addEventListener('mousedown', this.mouseDown);
    dom.addEventListener('dragstart', this.dragStart);
    dom.addEventListener('dragend', this.dragEnd);
    dom.addEventListener('click', this.click);
    dom.addEventListener('keydown', this.handleKey);
    // The provider sets the container draggable after addEvent; only the grip
    // should initiate a drag, never the insertion button.
    queueMicrotask(() => { dom.draggable = false; });
  };
  override removeEvent = (dom: HTMLElement) => {
    dom.removeEventListener('mousedown', this.mouseDown);
    dom.removeEventListener('dragstart', this.dragStart);
    dom.removeEventListener('dragend', this.dragEnd);
    dom.removeEventListener('click', this.click);
    dom.removeEventListener('keydown', this.handleKey);
  };
  private mouseDown = (event: MouseEvent) => {
    this.captured = null; this.suppressClick = false;
    const view = this.view;
    if (event.button !== 0 || !view || !view.editable || view.composing) return;
    cancelAnimationFrame(this.frame); this.frame = 0;
    const active = this.active;
    if (!active || view.state.doc.nodeAt(active.$pos.pos) !== active.node || !NodeSelection.isSelectable(active.node)) return;
    this.captured = captureBlock(view.state, active.$pos.pos);
  };
  private dragStart = (event: DragEvent) => {
    const view = this.view, target = this.captured, active = this.active;
    if (!view || !target || !active || event.target !== (event.currentTarget as HTMLElement).lastElementChild) { event.preventDefault(); return; }
    this.menu?.close(false); this.suppressClick = true;
    this.drag = new BlockDrag(view, this.scroll!, tr => this.apply(tr), this.highlight, () => { this.captured = null; this.hide(); });
    if (!this.drag.start(event, target, blockLabel(target))) event.preventDefault();
  };
  private dragEnd = () => this.drag?.cancel();
  override keydownCallback = () => { if (!this.drag?.active) this.hide(); return false; };
  override dragendCallback = () => { this.drag?.cancel(); };
  override dropCallback = () => false;
  override dragenterCallback = () => {};
  override dragleaveCallback = () => {};
  override dragoverCallback = () => false;

  private click = (event: MouseEvent) => {
    const grip = (event.currentTarget as HTMLElement).lastElementChild as HTMLElement;
    if (!(event.target instanceof Node) || !grip.contains(event.target) || this.suppressClick) return;
    event.preventDefault(); event.stopPropagation(); this.openMenu(grip);
  };
  private handleKey = (event: KeyboardEvent) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const dom = event.currentTarget as HTMLElement;
    if (event.target === dom.lastElementChild) this.openMenu(dom.lastElementChild as HTMLElement);
    else if (event.target === dom.firstElementChild) dom.firstElementChild?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  private apply(tr: Transaction) {
    const view = this.view;
    if (!view || !view.editable || view.state.doc !== tr.before) return;
    this.menu?.close(false);
    view.dispatch(closeHistory(tr)); view.dispatch(closeHistory(view.state.tr));
    this.changed(); view.focus();
  }
  private openMenu(grip: HTMLElement) {
    if (this.menu) { this.menu.close(true); return; }
    const view = this.view, active = this.active;
    if (!view?.editable || view.composing || !active) return;
    const target = captureBlock(view.state, active.$pos.pos);
    if (!target || target.node !== active.node) return;
    cancelAnimationFrame(this.frame); this.frame = 0;
    const valid = () => Boolean(this.view === view && view.editable && currentBlock(view.state, target));
    const mutation = (id: string, label: string, make: () => Transaction | null, icon = 'page'): BlockAction => ({ id, label, icon, disabled: !make(), run: () => {
      if (!valid()) { this.menu?.close(false); return; }
      const tr = make(); if (tr) this.apply(tr);
    } });
    const group = (id: string, label: string, children: BlockAction[], icon: string): BlockAction => ({ id, label, children, icon, disabled: children.every(child => child.disabled) });
    const conversions: [BlockType, string][] = [['paragraph', t('正文')], ...[1, 2, 3, 4, 5, 6].map(level => [`h${level}` as BlockType, t('标题 {0}', level)] as [BlockType, string]), ['bullet', t('无序列表')], ['ordered', t('有序列表')], ['task', t('待办清单')], ['blockquote', t('引用')], ['code_block', t('代码块')]];
    const actions: BlockAction[] = [
      group('convert', t('转换为'), conversions.map(([type, label]) => mutation(`convert-${type}`, label, () => convertBlock(view.state, target, type))), 'source'),
      group('style', t('文字样式'), [[t('加粗'), 'strong'], [t('斜体'), 'emphasis'], [t('删除线'), 'strike_through'], [t('高亮'), 'moye_highlight'], [t('清除文字样式'), 'clear']].map(([label, mark]) => mutation(`style-${mark}`, label, () => styleBlock(view.state, target, mark), 'style')), 'style'),
    ];
    if (target.node.type.name === 'list_item') {
      const command = (action: Command): Transaction | null => {
        if (!valid()) return null;
        const state = view.state.apply(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(target.pos + 1))));
        let tr: Transaction | null = null; action(state, transaction => { tr = transaction; }); return tr;
      };
      const list = [mutation('indent', t('增加缩进'), () => command(sinkListItem(view.state.schema.nodes.list_item)), 'chevron'), mutation('outdent', t('减少缩进'), () => command(liftListItem(view.state.schema.nodes.list_item)), 'back')];
      if (typeof target.node.attrs.checked === 'boolean') list.unshift(mutation('check', target.node.attrs.checked ? t('标记为未完成') : t('标记为完成'), () => valid() ? view.state.tr.setNodeMarkup(target.pos, null, { ...target.node.attrs, checked: !target.node.attrs.checked }) : null, 'check'));
      actions.push(group('list', t('列表操作'), list, 'list'));
    }
    const copy = (markdown: boolean): BlockAction => ({ id: markdown ? 'copy-markdown' : 'copy-text', label: markdown ? t('复制为 Markdown') : t('复制为纯文本'), icon: markdown ? 'source' : 'page', run: async () => {
      if (!valid()) { this.menu?.close(false); return; }
      const menu = this.menu;
      const text = markdown ? this.context!.get(serializerCtx)(blockDocument(view.state, target)) : blockPlainText(view.state, target);
      await window.moye.writeClipboardText(text); menu?.status(t('已复制'));
    } });
    actions.push(copy(true), copy(false), mutation('duplicate', t('创建副本'), () => duplicateBlock(view.state, target), 'page'));
    actions.push(group('move', t('移动'), (['up', 'down', 'first', 'last'] as BlockMove[]).map((direction, i) => mutation(`move-${direction}`, [t('上移一块'), t('下移一块'), t('移到当前层级开头'), t('移到当前层级末尾')][i], () => {
      const destination = siblingDestination(target, direction); return destination === null ? null : moveBlock(view.state, target, destination);
    }, 'down')), 'down'));
    actions.push(group('insert', t('插入块'), [mutation('insert-before', t('在上方插入块'), () => insertNearBlock(view.state, target, false), 'plus'), mutation('insert-after', t('在下方插入块'), () => insertNearBlock(view.state, target, true), 'plus')], 'plus'));
    actions.push({ ...mutation('delete', t('删除'), () => deleteBlock(view.state, target), 'close'), danger: true });
    this.highlight(target, 'moye-block-menu-target'); grip.setAttribute('aria-expanded', 'true');
    const text = target.node.textContent;
    this.menu = new BlockMenu(grip, blockLabel(target), t('{0} 个词 · {1} 个字符', countWords(text), [...text].length), actions, focus => {
      this.menu = null; this.highlight(null);
      grip.setAttribute('aria-expanded', 'false'); this.hide(); if (focus && valid()) view.focus();
    });
  }
}

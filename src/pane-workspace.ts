import { t, ht } from '../electron/i18n.mjs';
import { WritingEditor } from './editor';
import type { DocumentTab } from './document-tabs';
import type { Settings } from '../shared/moye';
import { groups, reconcileLayout, dockTab, mergeGroup, type PaneLayout, type PaneSplit, type PaneEdge } from '../electron/pane-layout.mjs';
import './pane-workspace.css';

interface View { tab: DocumentTab; scroll: HTMLElement; visual: HTMLElement; source: HTMLElement; editor: WritingEditor; loaded: boolean; cleanup?: () => void }
interface Hooks {
  settings(): Settings; blocked(): boolean;
  changed(tab: DocumentTab, content: string): void; selected(editor: WritingEditor): void;
  created(editor: WritingEditor, visual: HTMLElement): (() => void) | undefined;
  activate(id: string): void; dispatch(command: string, payload?: unknown): void; notify(message: string, error?: boolean): void;
}
export interface DockRequest { tabId: string; targetId: string; edge: PaneEdge | null; beforeId: string | null }
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export class PaneWorkspace {
  readonly root = document.createElement('div');
  readonly views = new Map<string, View>();
  private canvas = document.createElement('div');
  private parking = document.createElement('div');
  private panes = new Map<string, HTMLElement>();
  private layout?: PaneLayout;
  private tabs: DocumentTab[] = [];
  private activeId: string | null = null;
  private signature = '';
  private cancelGesture?: () => void;
  private suppressClick = false;
  constructor(private hooks: Hooks) {
    this.root.id = 'editor-workspace'; this.canvas.className = 'editor-layout'; this.parking.hidden = true;
    this.root.append(this.canvas);
    document.querySelector('#document-scroll')!.replaceWith(this.root);
    const activate = (event: Event) => {
      const target = event.target as HTMLElement, view = target.closest<HTMLElement>('[data-view-tab]');
      if (view && view.dataset.viewTab !== this.activeId) {
        if (this.hooks.blocked()) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); return; }
        this.hooks.activate(view.dataset.viewTab!);
      }
    };
    for (const event of ['pointerdown', 'focusin', 'drop', 'contextmenu']) document.addEventListener(event, activate, true);
    document.addEventListener('pointerdown', event => this.startDrag(event));
    document.addEventListener('click', event => {
      if (this.suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const close = (event.target as HTMLElement).closest<HTMLElement>('[data-merge-pane]');
      if (close && this.layout && !this.hooks.blocked()) this.hooks.dispatch('pane-layout', { layout: mergeGroup(this.layout, close.dataset.mergePane!), previous: this.snapshot() });
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.cancelGesture) { event.preventDefault(); event.stopImmediatePropagation(); this.cancelGesture(); } }, true);
    window.addEventListener('blur', () => this.cancelGesture?.());
  }
  async prepare(tab: DocumentTab) {
    if (this.views.has(tab.id)) return;
    const scroll = document.createElement('main'); scroll.className = 'document-scroll'; scroll.dataset.viewTab = tab.id;
    const visual = document.createElement('div'); visual.className = 'editor-host'; visual.setAttribute('aria-label', t("即时预览编辑区"));
    const source = document.createElement('div'); source.className = 'source-editor'; source.hidden = true;
    scroll.append(visual, source); this.parking.append(scroll);
    const editor = new WritingEditor(visual, source, content => this.hooks.changed(tab, content), () => tab.document.path, message => this.hooks.notify(message, true));
    try { await editor.create(); editor.updateSettings(this.hooks.settings()); }
    catch (error) { await editor.destroy(); scroll.remove(); throw error; }
    visual.querySelector('.ProseMirror')!.classList.add('moye-document');
    this.views.set(tab.id, { tab, scroll, visual, source, editor, loaded: false, cleanup: this.hooks.created(editor, visual) });
  }
  restoreView(tab: DocumentTab) {
    const view = this.views.get(tab.id)!;
    view.editor.load(tab.document.content); view.editor.setMode(tab.mode, tab.document.content);
    view.editor.cancelPendingActions(); view.loaded = true;
  }
  select(tab: DocumentTab) {
    const view = this.views.get(tab.id)!;
    if (this.activeId !== tab.id) this.views.get(this.activeId!)?.editor.cancelPendingActions();
    if (this.layout && !groups(this.layout).some(group => group.tabs.includes(tab.id))) {
      const group = groups(this.layout).find(group => group.tabs.includes(this.activeId!)) || groups(this.layout)[0];
      group.tabs.push(tab.id); group.activeId = tab.id;
    }
    this.activeId = tab.id;
    for (const item of this.views.values()) { item.scroll.removeAttribute('id'); item.visual.removeAttribute('id'); item.source.removeAttribute('id'); }
    view.scroll.id = 'document-scroll'; view.visual.id = 'visual-editor'; view.source.id = 'source-editor';
    this.hooks.selected(view.editor);
    const loaded = view.loaded; view.loaded = true; return loaded;
  }
  flush() { for (const view of this.views.values()) if (view.loaded) view.editor.flush(); }
  snapshot() { return this.layout ? structuredClone(this.layout) : undefined; }
  setLayout(layout?: PaneLayout) { this.layout = layout ? structuredClone(layout) : undefined; }
  dock(request: DockRequest) { this.layout = dockTab(this.layout!, request.tabId, request.targetId, request.edge, request.beforeId, crypto.randomUUID()); }
  async prune(ids: Set<string>) {
    for (const [id, view] of this.views) if (view.loaded && !ids.has(id)) { this.views.delete(id); try { view.cleanup?.(); await view.editor.destroy(); } catch (error) { console.warn('Closed editor cleanup failed:', error); } view.scroll.remove(); }
  }
  update(tabs: DocumentTab[], activeId: string | null) {
    this.tabs = tabs; this.activeId = activeId;
    this.layout = reconcileLayout(this.layout, tabs.map(tab => tab.id), activeId);
    if (!this.layout) return;
    const all = groups(this.layout), active = all.find(group => group.tabs.includes(activeId!));
    if (active && activeId) active.activeId = activeId;
    const shape = (node: PaneLayout): unknown => node.type === 'group' ? node.id : [node.axis, shape(node.first), shape(node.second)];
    const signature = JSON.stringify(shape(this.layout));
    if (signature !== this.signature) {
      for (const view of this.views.values()) if (view.scroll.parentElement !== this.parking) this.parking.append(view.scroll);
      this.panes.clear(); this.canvas.replaceChildren(this.build(this.layout, '')); this.signature = signature;
    }
    const minimum = this.minimum(this.layout); this.canvas.style.minWidth = `${minimum.width}px`; this.canvas.style.minHeight = `${minimum.height}px`;
    this.applyRatios(this.layout, '');
    this.root.classList.toggle('is-split', all.length > 1);
    document.querySelector<HTMLElement>('.document-tab-list')!.hidden = all.length > 1;
    for (const group of all) {
      const pane = this.panes.get(group.id)!, body = pane.querySelector('.pane-body')!;
      pane.classList.toggle('active-pane', group === active);
      const header = pane.querySelector<HTMLElement>('.pane-tabs')!; header.hidden = all.length === 1;
      const html = group.tabs.map(id => {
        const tab = tabs.find(tab => tab.id === id)!;
        return `<div class="document-tab ${id === group.activeId ? 'active' : ''}"><button type="button" role="tab" aria-selected="${id === group.activeId}" data-document-id="${id}" title="${escape(tab.document.path || tab.document.name)}"><span class="tab-dirty ${tab.document.content !== tab.savedContent ? 'visible' : ''}">●</span><span>${escape(tab.document.name)}</span></button><button type="button" data-document-id="${id}" data-close-tab="true" class="close-document-tab" aria-label="${ht("关闭 {0}", escape(tab.document.name))}">×</button></div>`;
      }).join('') + `<button type="button" class="pane-merge" data-merge-pane="${group.id}" title="${ht("收起分栏，将文稿移到相邻栏")}" aria-label="${ht("收起分栏")}">⇤</button>`;
      const content = all.length > 1 ? html : '';
      if (header.innerHTML !== content) header.innerHTML = content;
      const view = this.views.get(group.activeId);
      for (const child of [...body.children]) if (child !== view?.scroll) this.parking.append(child);
      if (view && view.scroll.parentElement !== body) body.append(view.scroll);
    }
  }
  private minimum(node: PaneLayout): { width: number; height: number } {
    if (node.type === 'group') return { width: 240, height: 160 };
    const first = this.minimum(node.first), second = this.minimum(node.second);
    return { width: node.axis === 'row' ? first.width + second.width + 6 : Math.max(first.width, second.width), height: node.axis === 'column' ? first.height + second.height + 6 : Math.max(first.height, second.height) };
  }
  private build(node: PaneLayout, path: string): HTMLElement {
    if (node.type === 'group') {
      const pane = document.createElement('section'); pane.className = 'editor-pane'; pane.dataset.groupId = node.id;
      pane.innerHTML = `<div class="pane-tabs" role="tablist" aria-label="${ht("分栏文稿")}"></div><div class="pane-body"></div>`;
      this.panes.set(node.id, pane); return pane;
    }
    const split = document.createElement('div'); split.className = `editor-split ${node.axis}`; split.dataset.splitPath = path;
    const divider = document.createElement('div'); divider.className = 'pane-divider'; divider.tabIndex = 0; divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', t("调整分栏大小")); divider.setAttribute('aria-orientation', node.axis === 'row' ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-valuemin', '10'); divider.setAttribute('aria-valuemax', '90'); divider.title = t("拖动调整分栏比例；双击均分");
    divider.addEventListener('pointerdown', event => this.startResize(event, node, path));
    divider.addEventListener('dblclick', () => this.resizeByKey(node, path, .5));
    divider.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home'].includes(event.key)) {
        event.preventDefault(); this.resizeByKey(node, path, event.key === 'Home' ? .5 : this.splitAt(path).ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.05 : .05));
      }
    });
    const first = this.build(node.first, path + '0'), second = this.build(node.second, path + '1');
    for (const [element, child] of [[first, node.first], [second, node.second]] as const) {
      const minimum = this.minimum(child); element.style.minWidth = `${minimum.width}px`; element.style.minHeight = `${minimum.height}px`;
    }
    split.append(first, divider, second); return split;
  }
  private splitAt(path: string) { let node = this.layout!; for (const part of path) node = (node as PaneSplit)[part === '0' ? 'first' : 'second']; return node as PaneSplit; }
  private applyRatios(node: PaneLayout, path: string) {
    if (node.type === 'group') return;
    const element = this.canvas.querySelector<HTMLElement>(`[data-split-path="${path}"]`)!;
    element.style.setProperty('--pane-ratio', String(node.ratio));
    element.querySelector(':scope > .pane-divider')!.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
    this.applyRatios(node.first, path + '0'); this.applyRatios(node.second, path + '1');
  }
  private resizeByKey(_node: PaneSplit, path: string, ratio: number) {
    if (this.hooks.blocked()) return;
    const previous = this.snapshot(); this.splitAt(path).ratio = Math.max(.1, Math.min(.9, ratio));
    this.hooks.dispatch('pane-layout', { layout: this.snapshot(), previous });
  }
  private startResize(event: PointerEvent, node: PaneSplit, path: string) {
    if (event.button !== 0 || this.hooks.blocked()) return;
    event.preventDefault(); this.cancelGesture?.();
    const divider = event.currentTarget as HTMLElement, bounds = divider.parentElement!.getBoundingClientRect(), previous = this.snapshot();
    divider.setPointerCapture(event.pointerId); document.body.classList.add('resizing-panes');
    const move = (event: PointerEvent) => {
      const row = node.axis === 'row', size = row ? bounds.width : bounds.height;
      const minimum = Math.min(.4, (row ? 240 : 150) / size);
      this.splitAt(path).ratio = Math.max(minimum, Math.min(1 - minimum, ((row ? event.clientX - bounds.left : event.clientY - bounds.top) - 3) / (size - 6)));
      this.applyRatios(this.layout!, '');
    };
    const finish = (commit: boolean) => {
      divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); divider.removeEventListener('pointercancel', cancel);
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      document.body.classList.remove('resizing-panes'); this.cancelGesture = undefined;
      if (commit) this.hooks.dispatch('pane-layout', { layout: this.snapshot(), previous });
      else { this.setLayout(previous); this.applyRatios(this.layout!, ''); }
    };
    const up = () => finish(true), cancel = () => finish(false);
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', up); divider.addEventListener('pointercancel', cancel); this.cancelGesture = cancel;
  }
  private startDrag(event: PointerEvent) {
    const button = (event.target as HTMLElement).closest<HTMLElement>('.document-tab [role="tab"]');
    if (!button || event.button !== 0 || this.hooks.blocked()) return;
    const tabId = button.dataset.documentId!, x = event.clientX, y = event.clientY;
    let dragging = false, target: DockRequest | null = null, outside = false;
    const preview = document.createElement('div'); preview.className = 'pane-drop-preview'; preview.hidden = true;
    const ghost = document.createElement('div'); ghost.className = 'pane-drag-label'; ghost.textContent = this.tabs.find(tab => tab.id === tabId)?.document.name || t("文稿");
    const move = (point: PointerEvent) => {
      if (!dragging && Math.hypot(point.clientX - x, point.clientY - y) < 6) return;
      if (!dragging) { dragging = true; document.body.setPointerCapture(event.pointerId); document.body.append(preview, ghost); document.body.classList.add('dragging-tab'); }
      point.preventDefault(); ghost.style.left = `${point.clientX + 14}px`; ghost.style.top = `${point.clientY + 14}px`;
      const hit = document.elementFromPoint(point.clientX, point.clientY) as HTMLElement | null;
      const pane = hit?.closest<HTMLElement>('.editor-pane');
      const list = hit?.closest<HTMLElement>('.pane-tabs,.document-tab-list');
      const group = list?.classList.contains('document-tab-list') ? groups(this.layout)[0] : groups(this.layout).find(group => group.id === pane?.dataset.groupId);
      target = null; preview.hidden = true;
      outside = point.clientX < 0 || point.clientY < 0 || point.clientX > innerWidth || point.clientY > innerHeight;
      if (!group) { ghost.textContent = outside ? t("松开后移至独立窗口") : t("拖到分栏边缘，或拖到标签栏合并"); return; }
      const bounds = (list || pane!.querySelector('.pane-body')!).getBoundingClientRect();
      const rx = (point.clientX - bounds.left) / bounds.width, ry = (point.clientY - bounds.top) / bounds.height;
      const distances = [['left', rx], ['right', 1 - rx], ['top', ry], ['bottom', 1 - ry]] as const;
      const nearest = [...distances].sort((a, b) => a[1] - b[1])[0];
      const edge: PaneEdge | null = !list && nearest[1] < .23 ? nearest[0] : null;
      const before = list ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => point.clientX < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2)?.dataset.documentId || null : null;
      target = { tabId, targetId: group.id, edge, beforeId: before };
      const rect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
      if (edge === 'left' || edge === 'right') { rect.width /= 2; if (edge === 'right') rect.left += rect.width; }
      if (edge === 'top' || edge === 'bottom') { rect.height /= 2; if (edge === 'bottom') rect.top += rect.height; }
      Object.assign(preview.style, Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, `${value}px`]))); preview.hidden = false;
      const sameSingle = group.tabs.length === 1 && group.tabs[0] === tabId && edge;
      ghost.textContent = sameSingle ? t("先打开另一篇文稿，再拖动分栏") : edge ? t("松开后{0}分栏", { left: t("向左"), right: t("向右"), top: t("向上"), bottom: t("向下") }[edge]) : t("松开后移入此栏");
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
      if (document.body.hasPointerCapture(event.pointerId)) document.body.releasePointerCapture(event.pointerId);
      preview.remove(); ghost.remove(); document.body.classList.remove('dragging-tab'); this.cancelGesture = undefined;
      if (!dragging) return;
      this.suppressClick = true; setTimeout(() => { this.suppressClick = false; }, 0);
      if (commit && target) this.hooks.dispatch('dock-tab', target);
      else if (commit && outside) this.hooks.dispatch('detach-document', tabId);
    };
    const up = () => finish(true), cancel = () => finish(false);
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true); this.cancelGesture = cancel;
  }
}

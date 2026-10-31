import { NodeSelection, type Selection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { t } from '../electron/i18n.mjs';
import { captureBlock, currentBlock, moveBlock, type BlockTarget } from './editor-block-model';

interface DropSlot { pos: number; x: number; y: number; width: number }
export class BlockDrag {
  active = false;
  private target: BlockTarget | null = null;
  private originalSelection: Selection | null = null;
  private point = { x: 0, y: 0, copy: false };
  private indicator = document.createElement('div');
  private preview = document.createElement('div');
  private ghost = document.createElement('canvas');
  private frame = 0;
  private previousTime = 0;
  private transaction: Transaction | null = null;
  private destination = -1;
  private copied = false;
  private overflow = '';
  private gutter = '';
  private blocks: { node: BlockTarget['node']; pos: number; element: HTMLElement }[] = [];
  constructor(private view: EditorView, private scroll: HTMLElement,
    private apply: (transaction: Transaction) => void,
    private highlight: (target: BlockTarget | null, kind?: string, duration?: number) => void, private done: () => void) {}

  start(event: DragEvent, target: BlockTarget, label: string) {
    if (!event.dataTransfer || !this.view.editable || !currentBlock(this.view.state, target)) return false;
    this.target = target; this.originalSelection = this.view.state.selection;
    this.active = true; this.point = { x: event.clientX, y: event.clientY, copy: event.altKey };
    // Own edge scrolling for this gesture. Chromium's native drag autoscroll
    // otherwise competes with our frame loop and can outlive Escape on Windows.
    // Hidden overflow still permits scrollTop; the stable gutter avoids reflow.
    this.overflow = this.scroll.style.overflowY; this.gutter = this.scroll.style.scrollbarGutter;
    if (this.scroll.scrollHeight > this.scroll.clientHeight) this.scroll.style.scrollbarGutter = 'stable';
    this.scroll.style.overflowY = 'hidden';
    this.view.dom.dataset.dragging = 'true';
    // Chromium cancels a pending native drag when DOM selection changes on
    // mousedown. Capture the block then, but select it only inside dragstart.
    const selection = NodeSelection.create(this.view.state.doc, target.pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    const slice = selection.content(), { dom, text } = this.view.serializeForClipboard(slice);
    event.dataTransfer.clearData(); event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/html', dom.innerHTML); event.dataTransfer.setData('text/plain', text);
    this.view.dragging = { slice, move: true };
    this.ghost.width = this.ghost.height = 1; this.ghost.className = 'moye-block-native-ghost'; document.body.append(this.ghost);
    event.dataTransfer.setDragImage(this.ghost, 0, 0);
    this.indicator.className = 'moye-block-drop-line'; this.indicator.hidden = true;
    this.preview.className = 'moye-block-drag-preview'; this.preview.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong'); title.textContent = label;
    const summary = document.createElement('span'); summary.textContent = target.node.textContent.slice(0, 100) || label;
    const hint = document.createElement('small'); hint.textContent = t('Alt / Option 拖动可复制 · Esc 取消');
    this.preview.append(title, summary, hint); document.body.append(this.indicator, this.preview);
    this.highlight(target, 'moye-block-drag-source');
    this.view.state.doc.forEach((node, pos) => { const element = this.view.nodeDOM(pos); if (element instanceof HTMLElement) this.blocks.push({ node, pos, element }); });
    window.addEventListener('dragover', this.over, true); window.addEventListener('drop', this.drop, true);
    window.addEventListener('dragend', this.end, true); window.addEventListener('keydown', this.keydown, true);
    window.addEventListener('blur', this.blur);
    this.frame = requestAnimationFrame(this.tick);
    return true;
  }
  cancel() { this.finish(true); }
  private finish(restore: boolean) {
    if (!this.active) return;
    this.active = false; cancelAnimationFrame(this.frame); this.frame = 0;
    window.removeEventListener('dragover', this.over, true); window.removeEventListener('drop', this.drop, true);
    window.removeEventListener('dragend', this.end, true); window.removeEventListener('keydown', this.keydown, true);
    window.removeEventListener('blur', this.blur);
    this.highlight(null); this.view.dom.dataset.dragging = 'false'; this.view.dragging = null;
    this.indicator.remove(); this.preview.remove(); this.ghost.remove();
    this.scroll.style.overflowY = this.overflow; this.scroll.style.scrollbarGutter = this.gutter;
    if (restore && this.target && currentBlock(this.view.state, this.target) && this.originalSelection)
      this.view.dispatch(this.view.state.tr.setSelection(this.originalSelection));
    this.target = null; this.originalSelection = null; this.transaction = null; this.blocks = []; this.done();
    if (restore) {
      // Escape or a document switch can cancel our model before the OS ends
      // its drag. Swallow that gesture's final drop instead of letting the
      // default text drop handler reinsert its stale clipboard payload.
      window.addEventListener('dragover', this.cancelledOver, true); window.addEventListener('drop', this.cancelledDrop, true);
      for (const name of ['dragend', 'pointerdown', 'dragstart']) window.addEventListener(name, this.releaseCancelled, true);
    }
  }
  private releaseCancelled = () => {
    window.removeEventListener('dragover', this.cancelledOver, true); window.removeEventListener('drop', this.cancelledDrop, true);
    for (const name of ['dragend', 'pointerdown', 'dragstart']) window.removeEventListener(name, this.releaseCancelled, true);
  };
  private cancelledOver = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; };
  private cancelledDrop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); this.releaseCancelled(); };
  private blur = () => this.cancel();
  private end = () => { this.cancel(); this.releaseCancelled(); };
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); }
  };
  private over = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    this.point = { x: event.clientX, y: event.clientY, copy: event.altKey };
    this.update();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.transaction ? (this.point.copy ? 'copy' : 'move') : 'none';
  };
  private drop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    this.point = { x: event.clientX, y: event.clientY, copy: event.altKey }; this.update();
    const tr = this.transaction;
    this.finish(!tr);
    if (tr) {
      this.apply(tr); this.view.focus();
      const $pos = this.view.state.selection.$from;
      const target = captureBlock(this.view.state, $pos.depth ? $pos.before(1) : $pos.pos);
      this.highlight(target, 'moye-block-dropped', 650);
    }
  };
  private tick = (time: number) => {
    if (!this.active) return;
    if (!this.target || !currentBlock(this.view.state, this.target) || !this.view.editable || !this.view.dom.isConnected) { this.cancel(); return; }
    const rect = this.scroll.getBoundingClientRect(), dt = this.previousTime ? Math.min(32, time - this.previousTime) / 1000 : 0;
    this.previousTime = time;
    if (this.point.x >= rect.left && this.point.x <= rect.right && this.point.y >= rect.top && this.point.y <= rect.bottom) {
      const zone = Math.min(64, rect.height / 4);
      const edge = this.point.y < rect.top + zone ? -(1 - (this.point.y - rect.top) / zone)
        : this.point.y > rect.bottom - zone ? 1 - (rect.bottom - this.point.y) / zone : 0;
      this.scroll.scrollTop += Math.sign(edge) * edge * edge * 780 * dt;
    }
    this.update(); this.frame = requestAnimationFrame(this.tick);
  };
  private update() {
    if (!this.active || !this.target || !currentBlock(this.view.state, this.target)) { this.transaction = null; return; }
    const slot = this.slot();
    this.preview.style.transform = `translate3d(${Math.max(8, Math.min(innerWidth - 290, this.point.x + 18))}px, ${Math.max(8, Math.min(innerHeight - 90, this.point.y + 20))}px, 0)`;
    this.preview.dataset.copy = String(this.point.copy);
    if (!slot) { this.transaction = null; this.destination = -1; this.indicator.hidden = true; return; }
    if (slot.pos !== this.destination || this.point.copy !== this.copied) {
      this.transaction = moveBlock(this.view.state, this.target, slot.pos, this.point.copy);
      this.destination = slot.pos; this.copied = this.point.copy;
    }
    this.indicator.hidden = !this.transaction;
    Object.assign(this.indicator.style, { left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.width}px` });
  }
  private slot(): DropSlot | null {
    const viewport = this.scroll.getBoundingClientRect(), editor = this.view.dom.getBoundingClientRect(), { x, y } = this.point;
    if (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) return null;
    // Work only inside this pane; another editor can never consume this drag.
    const hitElement = document.elementFromPoint(x, y);
    if (hitElement?.closest('.document-scroll') !== this.scroll) return null;
    const blocks = this.blocks;
    if (!blocks.length) return null;
    // Avoid measuring every preceding paragraph on each frame in long files.
    let low = 0, high = blocks.length;
    while (low < high) { const mid = (low + high) >>> 1; if (blocks[mid].element.getBoundingClientRect().bottom < y) low = mid + 1; else high = mid; }
    const indexAtPoint = Math.min(low, blocks.length - 1);
    let chosen = blocks[indexAtPoint];
    let rect = chosen.element.getBoundingClientRect();
    if (indexAtPoint && y < rect.top && y - blocks[indexAtPoint - 1].element.getBoundingClientRect().bottom < rect.top - y) { chosen = blocks[indexAtPoint - 1]; rect = chosen.element.getBoundingClientRect(); }
    if (['list_item', 'paragraph'].includes(this.target!.node.type.name) && ['bullet_list', 'ordered_list'].includes(chosen.node.type.name) && y >= rect.top && y <= rect.bottom) {
      const hit = this.view.posAtCoords({ left: Math.max(editor.left + 32, Math.min(editor.right - 8, x)), top: y });
      if (hit) {
        const $hit = this.view.state.doc.resolve(hit.pos);
        for (let depth = $hit.depth; depth > 0; depth--) {
          const node = $hit.node(depth), pos = $hit.before(depth), element = this.view.nodeDOM(pos);
          if (node.type.name === 'list_item' && element instanceof HTMLElement) { chosen = { node, pos, element }; rect = element.getBoundingClientRect(); break; }
        }
      }
    }
    const after = y > (rect.top + rect.bottom) / 2, $pos = this.view.state.doc.resolve(chosen.pos), index = $pos.index();
    let line = after ? rect.bottom + 3 : rect.top - 3;
    const siblingPos = after ? (index + 1 < $pos.parent.childCount ? chosen.pos + chosen.node.nodeSize : null)
      : (index ? chosen.pos - $pos.parent.child(index - 1).nodeSize : null);
    if (siblingPos !== null) {
      const sibling = this.view.nodeDOM(siblingPos);
      if (sibling instanceof HTMLElement) { const bounds = sibling.getBoundingClientRect(); line = after ? (rect.bottom + bounds.top) / 2 : (bounds.bottom + rect.top) / 2; }
    }
    if (line < viewport.top + 1 || line > viewport.bottom - 1) return null;
    const left = Math.max(viewport.left + 8, rect.left), right = Math.min(viewport.right - 8, rect.right);
    return { pos: chosen.pos + (after ? chosen.node.nodeSize : 0), x: left, y: line, width: Math.max(16, right - left) };
  }
}

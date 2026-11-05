import { NodeSelection, type Selection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { captureBlock, currentBlock, moveBlock, type BlockTarget } from './editor-block-model';

interface DropSlot { pos: number; x: number; y: number; width: number }

// Keep the rendered block's typography and SVG markers without duplicating
// document IDs or carrying its editing controls into the floating preview.
function clonePreview(source: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button,.tools,.language-picker,.preview-label,.preview-divider,.drag-preview').forEach(element => element.remove());
  const elements = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  const prefix = `meki-drag-${crypto.randomUUID()}`;
  const ids = new Map(elements.filter(element => element.id).map((element, index) => [element.id, `${prefix}-${index}`]));
  const reference = (id: string) => ids.get(id) || id;
  for (const element of elements) {
    if (element.id) element.id = reference(element.id);
    element.removeAttribute('contenteditable');
    element.classList.remove('ProseMirror-selectednode', 'meki-block-drag-source', 'meki-block-dropped', 'meki-block-menu-target');
    for (const attribute of [...element.attributes]) {
      let value = attribute.value.replace(/url\((["']?)#([^)'"\s]+)\1\)/g, (_match, quote, id) => `url(${quote}#${reference(id)}${quote})`);
      if (attribute.localName === 'href' && value.startsWith('#')) value = `#${reference(value.slice(1))}`;
      if (['aria-labelledby', 'aria-describedby'].includes(attribute.name)) value = value.split(/\s+/).map(reference).join(' ');
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
  }
  if (ids.size) {
    const selectors = new RegExp(`#(${[...ids.keys()].sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[^\\w-]|$)`, 'g');
    clone.querySelectorAll('style').forEach(style => { style.textContent = style.textContent!.replace(selectors, (_match, id) => `#${reference(id)}`); });
  }
  return clone;
}

export class BlockDrag {
  active = false;
  private lifted = false;
  private target: BlockTarget | null = null;
  private originalSelection: Selection | null = null;
  private point = { x: 0, y: 0, copy: false };
  private origin = { x: 0, y: 0 };
  private pointerId = -1;
  private grip: HTMLElement | null = null;
  private label = '';
  private indicator = document.createElement('div');
  private preview = document.createElement('div');
  private frame = 0;
  private previousTime = 0;
  private transaction: Transaction | null = null;
  private destination = -1;
  private copied = false;
  private snap: { pos: number; after: boolean } | null = null;
  private blocks: { node: BlockTarget['node']; pos: number; element: HTMLElement }[] = [];
  constructor(private view: EditorView, private scroll: HTMLElement,
    private apply: (transaction: Transaction) => void,
    private highlight: (target: BlockTarget | null, kind?: string, duration?: number) => void,
    private onLift: () => void, private done: (lifted: boolean) => void) {}

  start(event: PointerEvent, target: BlockTarget, label: string, grip: HTMLElement) {
    if (!this.view.editable || !currentBlock(this.view.state, target)) return false;
    this.target = target; this.originalSelection = this.view.state.selection;
    this.active = true; this.point = { x: event.clientX, y: event.clientY, copy: event.altKey };
    this.origin = { x: event.clientX, y: event.clientY }; this.pointerId = event.pointerId; this.grip = grip; this.label = label;
    grip.setPointerCapture(event.pointerId);
    grip.addEventListener('lostpointercapture', this.cancel);
    window.addEventListener('pointermove', this.move, true); window.addEventListener('pointerup', this.drop, true);
    window.addEventListener('pointercancel', this.cancelPointer, true); window.addEventListener('keydown', this.keydown, true);
    window.addEventListener('keyup', this.modifier, true); window.addEventListener('blur', this.cancel);
    return true;
  }
  private lift() {
    const target = this.target!;
    this.lifted = true;
    this.onLift();
    const source = this.view.nodeDOM(target.pos);
    this.indicator.className = 'meki-block-drop-line'; this.indicator.hidden = true;
    this.preview.className = 'meki-block-drag-preview meki-document milkdown'; this.preview.setAttribute('aria-hidden', 'true'); this.preview.inert = true;
    const content = document.createElement('div'); content.className = 'meki-block-drag-content';
    if (source instanceof HTMLElement) {
      const clone = clonePreview(source);
      if (clone.tagName === 'LI') {
        const list = document.createElement(source.parentElement?.tagName === 'OL' ? 'ol' : 'ul'); list.append(clone); content.append(list);
      } else content.append(clone);
      this.preview.style.width = `${Math.min(440, source.getBoundingClientRect().width + 24)}px`;
    } else content.textContent = target.node.textContent || this.label;
    const copy = document.createElement('span'); copy.className = 'meki-block-drag-copy'; copy.textContent = '+';
    this.preview.append(content, copy); document.body.append(this.indicator, this.preview);
    this.preview.dataset.truncated = String(content.scrollHeight > 76);
    document.body.classList.add('meki-block-dragging');
    this.view.dom.dataset.dragging = 'true';
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, target.pos)));
    this.highlight(target, 'meki-block-drag-source');
    this.view.state.doc.forEach((node, pos) => { const element = this.view.nodeDOM(pos); if (element instanceof HTMLElement) this.blocks.push({ node, pos, element }); });
    this.update();
    this.frame = requestAnimationFrame(this.tick);
  }
  cancel = () => { this.finish(true); };
  private finish(restore: boolean) {
    if (!this.active) return;
    this.active = false; cancelAnimationFrame(this.frame); this.frame = 0;
    window.removeEventListener('pointermove', this.move, true); window.removeEventListener('pointerup', this.drop, true);
    window.removeEventListener('pointercancel', this.cancelPointer, true); window.removeEventListener('keydown', this.keydown, true);
    window.removeEventListener('keyup', this.modifier, true); window.removeEventListener('blur', this.cancel);
    this.grip?.removeEventListener('lostpointercapture', this.cancel);
    if (this.grip?.hasPointerCapture(this.pointerId)) this.grip.releasePointerCapture(this.pointerId);
    this.grip = null;
    if (this.lifted) {
      this.highlight(null); this.view.dom.dataset.dragging = 'false';
      document.body.classList.remove('meki-block-dragging'); this.indicator.remove(); this.preview.remove();
    }
    if (restore && this.lifted && this.target && currentBlock(this.view.state, this.target) && this.originalSelection)
      this.view.dispatch(this.view.state.tr.setSelection(this.originalSelection));
    this.target = null; this.originalSelection = null; this.transaction = null; this.blocks = []; this.done(this.lifted);
  }
  private cancelPointer = (event: PointerEvent) => { if (event.pointerId === this.pointerId) this.cancel(); };
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); }
    else this.modifier(event);
  };
  private modifier = (event: KeyboardEvent) => { this.point.copy = event.altKey; };
  private move = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    this.point = { x: event.clientX, y: event.clientY, copy: event.altKey };
    // A click or a small hand tremor still opens the block menu. Once lifted,
    // pointer events only record coordinates; layout work runs once per frame.
    if (!this.lifted && Math.hypot(this.point.x - this.origin.x, this.point.y - this.origin.y) >= 5) this.lift();
  };
  private drop = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    if (!this.lifted) { this.finish(false); return; }
    event.preventDefault(); event.stopPropagation();
    this.point = { x: event.clientX, y: event.clientY, copy: event.altKey }; this.update();
    const tr = this.transaction;
    this.finish(!tr);
    if (tr) {
      this.apply(tr); this.view.focus();
      const $pos = this.view.state.selection.$from;
      const target = captureBlock(this.view.state, $pos.depth ? $pos.before(1) : $pos.pos);
      this.highlight(target, 'meki-block-dropped', 420);
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
    const width = this.preview.offsetWidth, height = this.preview.offsetHeight;
    this.preview.style.transform = `translate3d(${Math.max(8, Math.min(innerWidth - width - 8, this.point.x + 18))}px, ${Math.max(8, Math.min(innerHeight - height - 8, this.point.y + 16))}px, 0)`;
    this.preview.dataset.copy = String(this.point.copy);
    if (!slot) { this.transaction = null; this.destination = -1; this.snap = null; this.indicator.hidden = true; return; }
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
    const middle = (rect.top + rect.bottom) / 2;
    // Keep the current side around the midpoint rather than flickering between
    // two insertion lines on tiny pointer movements.
    const after = this.snap?.pos === chosen.pos && Math.abs(y - middle) < Math.min(6, rect.height / 4) ? this.snap.after : y > middle;
    this.snap = { pos: chosen.pos, after };
    const $pos = this.view.state.doc.resolve(chosen.pos), index = $pos.index();
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

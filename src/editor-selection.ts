import { $prose } from '@milkdown/kit/utils';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

function pointerSelection(view: EditorView, event: MouseEvent) {
  if (!view.editable || view.composing || event.button !== 0 || event.detail > 1 ||
    event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ||
    !(event.target instanceof Element) || event.target.closest('[contenteditable="false"]')) return null;
  const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!point) return null;
  const position = view.state.doc.resolve(point.pos);
  if (!position.parent.inlineContent && event.target !== view.dom) return null;
  const selection = TextSelection.near(position);
  return selection instanceof TextSelection ? selection : null;
}

function commitSelection(view: EditorView, selection: TextSelection) {
  if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
}

// A native caret change can reach selectionchange after the next key on macOS.
// Commit the clicked text position before focus/keyboard handlers use the model.
export const textPointerSelection = $prose(() => {
  let deferredClick: { x: number; y: number } | null = null;
  const moved = (event: MouseEvent) => deferredClick && (Math.abs(event.clientX - deferredClick.x) > 4 || Math.abs(event.clientY - deferredClick.y) > 4);
  return new Plugin({ props: {
    handleDOMEvents: { mousedown: (view, event) => {
      deferredClick = null;
      const selection = pointerSelection(view, event);
      if (!selection) return false;
      // Preserve the range until the browser distinguishes a click from a drag.
      const current = view.state.selection;
      if (!current.empty && selection.from >= current.from && selection.from <= current.to) deferredClick = { x: event.clientX, y: event.clientY };
      else commitSelection(view, selection);
      return false;
    }, mousemove: (_view, event) => {
      if (moved(event)) deferredClick = null;
      return false;
    }, dragstart: () => {
      deferredClick = null;
      return false;
    }, click: (view, event) => {
      if (!deferredClick) return false;
      const selection = moved(event) ? null : pointerSelection(view, event);
      deferredClick = null;
      if (!selection) return false;
      // The native click follows mouseup. Its click count also distinguishes
      // rapid single clicks separated by keyboard/menu actions from a double
      // click. Synchronize before the next typing/select-all command.
      commitSelection(view, selection);
      return false;
    } },
  } });
});

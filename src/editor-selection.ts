import { $prose } from '@milkdown/kit/utils';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';

// A native caret change can reach selectionchange after the next key on macOS.
// Commit the clicked text position before focus/keyboard handlers use the model.
export const textPointerSelection = $prose(() => new Plugin({
  props: { handleDOMEvents: { mousedown: (view, event) => {
    if (!view.editable || view.composing || event.button !== 0 || event.detail > 1 ||
      event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ||
      !(event.target instanceof Element) || event.target.closest('[contenteditable="false"]')) return false;
    const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!point) return false;
    const position = view.state.doc.resolve(point.pos);
    if (!position.parent.inlineContent && event.target !== view.dom) return false;
    const selection = TextSelection.near(position);
    if (!(selection instanceof TextSelection)) return false;
    if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
    return false;
  } } },
}));

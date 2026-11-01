import { TableNodeView } from '@milkdown/kit/component/table-block';
import { tableSchema } from '@milkdown/kit/preset/gfm';
import { $view } from '@milkdown/kit/utils';

// Let ProseMirror place the caret synchronously. Crepe's cell handler queues a
// selection transaction from the old document, which can race immediate typing.
class MekiTableView extends TableNodeView {
  override stopEvent(event: Event) {
    if ((event.type === 'mousedown' || event.type === 'pointerdown') && event.target instanceof Element &&
      event.target.closest('td, th') && !event.target.closest('button')) return false;
    return super.stopEvent(event);
  }
}
export const stableTableBlockView = $view(tableSchema.node, ctx => (node, view, getPos) => new MekiTableView(ctx, node, view, getPos));

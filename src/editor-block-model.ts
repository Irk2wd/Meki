import { Fragment, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { Selection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';

export interface BlockTarget { doc: ProseNode; node: ProseNode; pos: number }
export type BlockType = 'paragraph' | `h${number}` | 'bullet' | 'ordered' | 'task' | 'blockquote' | 'code_block';
export type BlockMove = 'up' | 'down' | 'first' | 'last';
const isList = (node: ProseNode) => ['bullet_list', 'ordered_list'].includes(node.type.name);

export function captureBlock(state: EditorState, pos: number): BlockTarget | null {
  if (pos < 0 || pos >= state.doc.content.size) return null;
  const node = state.doc.nodeAt(pos);
  return node?.isBlock ? { doc: state.doc, node, pos } : null;
}
export function currentBlock(state: EditorState, target: BlockTarget) {
  return state.doc === target.doc && state.doc.nodeAt(target.pos) === target.node;
}
function selected(tr: Transaction, pos: number) {
  return tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size, Math.max(0, pos + 1))))).scrollIntoView();
}
function removal(target: BlockTarget) {
  const $pos = target.doc.resolve(target.pos);
  if (target.node.type.name === 'list_item' && $pos.depth && isList($pos.parent) && $pos.parent.childCount === 1)
    return { from: $pos.before(), to: $pos.after() };
  return { from: target.pos, to: target.pos + target.node.nodeSize };
}
export function deleteBlock(state: EditorState, target: BlockTarget) {
  if (!currentBlock(state, target)) return null;
  const { from, to } = removal(target);
  return selected(state.tr.delete(from, to), from);
}
export function duplicateBlock(state: EditorState, target: BlockTarget) {
  if (!currentBlock(state, target)) return null;
  const at = target.pos + target.node.nodeSize;
  return selected(state.tr.insert(at, target.node), at);
}
export function insertNearBlock(state: EditorState, target: BlockTarget, after: boolean) {
  if (!currentBlock(state, target)) return null;
  const paragraph = state.schema.nodes.paragraph.create(), $pos = state.doc.resolve(target.pos);
  const node = isList($pos.parent) ? state.schema.nodes.list_item.create({ ...target.node.attrs, checked: typeof target.node.attrs.checked === 'boolean' ? false : null }, paragraph) : paragraph;
  const at = target.pos + (after ? target.node.nodeSize : 0);
  return selected(state.tr.insert(at, node), at);
}

// Both the menu and dragging use the same schema-checked block boundary move.
// In particular, a list item never becomes an invalid top-level node or a
// partially opened slice that ProseMirror could merge into a paragraph.
export function moveBlock(state: EditorState, target: BlockTarget, destination: number, copy = false): Transaction | null {
  if (!currentBlock(state, target) || destination < 0 || destination > state.doc.content.size) return null;
  const end = target.pos + target.node.nodeSize, range = removal(target);
  if (destination > target.pos && destination < end) return null;
  if (!copy && destination >= range.from && destination <= range.to) return null;
  const $destination = state.doc.resolve(destination), $source = state.doc.resolve(target.pos);
  if ($destination.parent.inlineContent || $destination.textOffset) return null;
  let node = target.node;
  if (isList($destination.parent)) {
    const attrs = { ...(node.type.name === 'list_item' ? node.attrs : {}),
      listType: $destination.parent.type.name === 'ordered_list' ? 'ordered' : 'bullet',
      label: $destination.parent.type.name === 'ordered_list' ? '1.' : '•' };
    if (node.type.name === 'list_item') node = node.type.create(attrs, node.content);
    else if (node.type.name === 'paragraph') node = state.schema.nodes.list_item.create({ ...attrs, checked: typeof $destination.parent.firstChild?.attrs.checked === 'boolean' ? false : null }, node);
    else return null;
  } else if (node.type.name === 'list_item' && isList($source.parent)) {
    node = $source.parent.copy(Fragment.from(node));
  }
  if (!$destination.parent.canReplace($destination.index(), $destination.index(), Fragment.from(node))) return null;
  const tr = state.tr;
  if (!copy) tr.delete(range.from, range.to);
  const at = tr.mapping.map(destination, destination <= range.from ? -1 : 1);
  const $at = tr.doc.resolve(at);
  if (!$at.parent.canReplace($at.index(), $at.index(), Fragment.from(node))) return null;
  tr.insert(at, node);
  return selected(tr, at);
}
export function siblingDestination(target: BlockTarget, direction: BlockMove): number | null {
  const $pos = target.doc.resolve(target.pos), index = $pos.index(), parent = $pos.parent;
  if (direction === 'up') return index ? target.pos - parent.child(index - 1).nodeSize : null;
  if (direction === 'down') return index + 1 < parent.childCount ? target.pos + target.node.nodeSize + parent.child(index + 1).nodeSize : null;
  if (direction === 'first') return index ? $pos.start() : null;
  return index + 1 < parent.childCount ? $pos.end() : null;
}
export function blockDocument(state: EditorState, target: BlockTarget): ProseNode {
  const $pos = target.doc.resolve(target.pos);
  const node = target.node.type.name === 'list_item' && isList($pos.parent) ? $pos.parent.copy(Fragment.from(target.node)) : target.node;
  return state.schema.topNodeType.create(null, node);
}
export function blockPlainText(state: EditorState, target: BlockTarget): string {
  const doc = blockDocument(state, target);
  return doc.textBetween(0, doc.content.size, '\n', node => String(node.attrs.value || node.attrs.alt || node.attrs.caption || node.attrs.label || node.attrs.src || ''));
}

function replaceBlock(state: EditorState, target: BlockTarget, content: Fragment): Transaction | null {
  let from = target.pos, to = from + target.node.nodeSize, selectedPos = from;
  const $pos = state.doc.resolve(from);
  if (target.node.type.name === 'list_item' && isList($pos.parent)) {
    // Split around this item, preserving its siblings, nested lists and ordered
    // list numbering. Only the chosen item changes type.
    const list = $pos.parent, offset = from - $pos.start(), before = list.content.cut(0, offset), after = list.content.cut(offset + target.node.nodeSize);
    from = $pos.before(); to = $pos.after(); selectedPos = from;
    if (before.size) { const head = list.copy(before); content = Fragment.from(head).append(content); selectedPos += head.nodeSize; }
    if (after.size) content = content.append(Fragment.from(list.type.create({ ...list.attrs,
      ...(list.type.name === 'ordered_list' ? { order: list.attrs.order + $pos.index() + 1 } : {}) }, after)));
  }
  const $from = state.doc.resolve(from), $to = state.doc.resolve(to);
  if ($from.parent !== $to.parent || !$from.parent.canReplace($from.index(), $to.index(), content)) return null;
  const tr = state.tr.replaceWith(from, to, content);
  return tr.doc.eq(state.doc) ? null : selected(tr, selectedPos);
}
export function convertBlock(state: EditorState, target: BlockTarget, type: BlockType): Transaction | null {
  if (!currentBlock(state, target)) return null;
  const { node } = target, schema = state.schema, name = node.type.name;
  if (!['paragraph', 'heading', 'code_block', 'blockquote', 'list_item'].includes(name)) return null;
  let blocks = name === 'blockquote' || name === 'list_item' ? node.content : Fragment.from(node);
  let first = blocks.firstChild!;
  if (type === 'blockquote') {
    if (name === 'blockquote') return null;
    return replaceBlock(state, target, Fragment.from(schema.nodes.blockquote.create(null, blocks)));
  }
  if (!first.isTextblock) return null;
  let inline = first.content;
  if (first.type.name === 'code_block' && type !== 'code_block') {
    const parts = first.textContent.split('\n'), nodes: ProseNode[] = [];
    parts.forEach((part, i) => { if (i && schema.nodes.hardbreak) nodes.push(schema.nodes.hardbreak.create()); if (part) nodes.push(schema.text(part)); });
    inline = Fragment.from(nodes);
  }
  if (type === 'code_block') {
    if (blocks.childCount !== 1 || name === 'code_block') return null;
    let text = '', valid = true;
    first.forEach(child => { if (child.isText) text += child.text; else if (child.type.name === 'hardbreak') text += '\n'; else valid = false; });
    if (!valid) return null; // Inline math, images and other atoms must survive.
    return replaceBlock(state, target, Fragment.from(schema.nodes.code_block.create(null, text ? schema.text(text) : null)));
  }
  const heading = /^h([1-6])$/.exec(type);
  if (type === 'paragraph' || heading) {
    const nodeType = heading ? schema.nodes.heading : schema.nodes.paragraph;
    if (!nodeType.validContent(inline)) return null;
    blocks = Fragment.from(nodeType.create(heading ? { level: Number(heading[1]) } : null, inline)).append(blocks.cut(first.nodeSize));
    return replaceBlock(state, target, blocks);
  }
  if (!['bullet', 'ordered', 'task'].includes(type) || !schema.nodes.paragraph.validContent(inline)) return null;
  first = schema.nodes.paragraph.create(null, inline);
  blocks = Fragment.from(first).append(blocks.cut(blocks.firstChild!.nodeSize));
  const listType = type === 'ordered' ? 'ordered_list' : 'bullet_list';
  const attrs = { ...(name === 'list_item' ? node.attrs : {}), checked: type === 'task' ? (node.attrs.checked ?? false) : null,
    listType: type === 'ordered' ? 'ordered' : 'bullet', label: type === 'ordered' ? '1.' : '•' };
  const item = schema.nodes.list_item.create(attrs, blocks);
  const $pos = state.doc.resolve(target.pos);
  if (name === 'list_item' && $pos.parent.type.name === listType) {
    if (item.eq(node)) return null;
    return selected(state.tr.replaceWith(target.pos, target.pos + node.nodeSize, item), target.pos);
  }
  return replaceBlock(state, target, Fragment.from(schema.nodes[listType].create(null, item)));
}

const styles = ['strong', 'emphasis', 'strike_through', 'meki_highlight', 'inline_code'];
export function styleBlock(state: EditorState, target: BlockTarget, name: string): Transaction | null {
  if (!currentBlock(state, target)) return null;
  const type = state.schema.marks[name];
  if (name !== 'clear' && !type) return null;
  const ranges: { from: number; to: number; marked: boolean }[] = [];
  target.node.descendants((node, offset, parent) => {
    if (parent?.type.spec.code) return false;
    if (node.isText && (name === 'clear' || parent?.type.allowsMarkType(type)))
      ranges.push({ from: target.pos + 1 + offset, to: target.pos + 1 + offset + node.nodeSize, marked: Boolean(type?.isInSet(node.marks)) });
  });
  if (!ranges.length) return null;
  const tr = state.tr, remove = ranges.every(range => range.marked);
  for (const range of ranges) {
    if (name === 'clear') { for (const style of styles) { const mark = state.schema.marks[style]; if (mark) tr.removeMark(range.from, range.to, mark); } }
    else if (remove) tr.removeMark(range.from, range.to, type);
    else tr.addMark(range.from, range.to, type.create());
  }
  return tr.docChanged && !tr.doc.eq(state.doc) ? tr : null;
}

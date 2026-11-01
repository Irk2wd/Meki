const test = require('node:test');
const assert = require('node:assert/strict');
const load = Promise.all([import('../src/editor-block-model.ts'), import('@milkdown/kit/prose/model'), import('@milkdown/kit/prose/state'), import('@milkdown/kit/prose/history')]);

async function fixture() {
  const [blocks, { Schema }, { EditorState }, history] = await load;
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, text: { group: 'inline' }, paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    code_block: { content: 'text*', group: 'block', code: true, marks: '', attrs: { language: { default: '' } } },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'listItem+', group: 'block', attrs: { spread: { default: false } } },
    ordered_list: { content: 'listItem+', group: 'block', attrs: { order: { default: 1 }, spread: { default: false } } },
    list_item: { content: 'paragraph block*', group: 'listItem', attrs: { checked: { default: null }, listType: { default: 'bullet' }, label: { default: '•' }, spread: { default: false } } },
    hardbreak: { inline: true, group: 'inline' }, math_inline: { inline: true, group: 'inline', atom: true, attrs: { value: { default: '' } } },
    image: { group: 'block', atom: true, attrs: { src: {}, width: { default: null } } },
    table: { group: 'block', content: 'table_row+' }, table_row: { content: 'table_cell+' }, table_cell: { content: 'paragraph+' },
  }, marks: { strong: {}, emphasis: {}, strike_through: {}, meki_highlight: {}, inline_code: { excludes: '_' }, link: { attrs: { href: {} } } } });
  const n = (type, content, attrs) => schema.nodes[type].create(attrs, content);
  const p = text => n('paragraph', text ? schema.text(text) : null), item = (text, tail = [], attrs = {}) => n('list_item', [p(text), ...tail], attrs);
  const state = content => EditorState.create({ schema, doc: n('doc', content), plugins: [history.history()] });
  const find = (state, type, text) => { let target; state.doc.descendants((node, pos) => { if (!target && node.type.name === type && (text === undefined || node.textContent === text)) target = blocks.captureBlock(state, pos); }); assert.ok(target, `${type} ${text}`); return target; };
  const reversible = (before, tr) => {
    assert.ok(tr); const after = before.apply(history.closeHistory(tr)); after.doc.check();
    let undone; assert.equal(history.undo(after, undo => { undone = after.apply(undo); }), true); assert.ok(undone.doc.eq(before.doc));
    let redone; assert.equal(history.redo(undone, redo => { redone = undone.apply(redo); }), true); assert.ok(redone.doc.eq(after.doc)); return after;
  };
  return { ...blocks, schema, n, p, item, state, find, reversible };
}

test('block moves use whole-node boundaries and undo/redo in one step', async () => {
  const f = await fixture(); const state = f.state([f.p('Alpha'), f.p('Beta'), f.p('Gamma')]), target = f.find(state, 'paragraph', 'Alpha');
  const after = f.reversible(state, f.moveBlock(state, target, state.doc.content.size));
  assert.deepEqual([...Array(after.doc.childCount)].map((_, i) => after.doc.child(i).textContent), ['Beta', 'Gamma', 'Alpha']);
  assert.equal(f.moveBlock(state, target, 2), null); assert.equal(f.moveBlock(state, target, target.node.nodeSize), null);
  assert.equal(f.moveBlock(state, target, -1), null);
  assert.equal(f.currentBlock(after, target), false); assert.equal(f.deleteBlock(after, target), null);
  const copied = f.reversible(state, f.moveBlock(state, target, state.doc.content.size, true)); assert.equal(copied.doc.childCount, 4); assert.equal(copied.doc.lastChild.textContent, 'Alpha');
});

test('menu moves stay in the current sibling level and duplicate/delete are reversible', async () => {
  const f = await fixture(), state = f.state([f.p('A'), f.p('B'), f.p('C')]), middle = f.find(state, 'paragraph', 'B');
  for (const direction of ['up', 'down', 'first', 'last']) f.reversible(state, f.moveBlock(state, middle, f.siblingDestination(middle, direction)));
  assert.equal(f.siblingDestination(f.find(state, 'paragraph', 'A'), 'up'), null);
  const duplicate = f.reversible(state, f.duplicateBlock(state, middle)); assert.equal(duplicate.doc.childCount, 4);
  const deleted = f.reversible(state, f.deleteBlock(state, middle)); assert.equal(deleted.doc.textContent, 'AC');
  const single = f.state([f.p('only')]); const empty = f.reversible(single, f.deleteBlock(single, f.find(single, 'paragraph'))); assert.equal(empty.doc.textContent, ''); assert.equal(empty.doc.childCount, 1);
});

test('nested task items retain children, attributes and list wrappers when moved', async () => {
  const f = await fixture(); const nested = f.n('bullet_list', [f.item('Nested')]);
  const state = f.state([f.p('Before'), f.n('bullet_list', [f.item('Task', [nested], { checked: true }), f.item('Other', [], { checked: false })]), f.p('After')]);
  const target = f.find(state, 'list_item', 'TaskNested'), other = f.find(state, 'list_item', 'Other');
  const moved = f.reversible(state, f.moveBlock(state, target, other.pos + other.node.nodeSize));
  assert.equal(moved.doc.child(1).firstChild.textContent, 'Other'); assert.equal(moved.doc.child(1).lastChild.attrs.checked, true);
  assert.ok(moved.doc.child(1).lastChild.lastChild.eq(nested));
  const outside = f.reversible(state, f.moveBlock(state, target, state.doc.content.size)); assert.equal(outside.doc.lastChild.type.name, 'bullet_list'); assert.ok(outside.doc.lastChild.firstChild.eq(target.node));
  assert.equal(f.moveBlock(state, target, target.pos + target.node.nodeSize - 2), null);
  const copy = f.blockDocument(state, target); copy.check(); assert.equal(copy.firstChild.type.name, 'bullet_list'); assert.ok(copy.firstChild.firstChild.eq(target.node));
});

test('singleton lists are removed cleanly and paragraphs can enter a task list', async () => {
  const f = await fixture(), state = f.state([f.n('bullet_list', [f.item('Only', [], { checked: true })]), f.p('Text'), f.p('Last')]);
  const target = f.find(state, 'list_item'); const after = f.reversible(state, f.moveBlock(state, target, state.doc.content.size));
  assert.equal(after.doc.childCount, 3); assert.equal(after.doc.firstChild.textContent, 'Text');
  const deleted = f.reversible(state, f.deleteBlock(state, target)); assert.equal(deleted.doc.childCount, 2);
  const inserted = f.reversible(state, f.moveBlock(state, f.find(state, 'paragraph', 'Text'), target.pos));
  assert.equal(inserted.doc.firstChild.firstChild.textContent, 'Text'); assert.equal(inserted.doc.firstChild.firstChild.attrs.checked, false);
  const newItem = f.reversible(state, f.insertNearBlock(state, target, true)); assert.equal(newItem.doc.firstChild.childCount, 2); assert.equal(newItem.doc.firstChild.lastChild.attrs.checked, false);
});

test('converting one ordered item splits the list and preserves numbering, inline marks and nested content', async () => {
  const f = await fixture(), marked = f.n('paragraph', f.schema.text('Title', [f.schema.marks.strong.create()])), nested = f.n('bullet_list', [f.item('Nested')]);
  const middle = f.n('list_item', [marked, nested]), state = f.state([f.n('ordered_list', [f.item('First'), middle, f.item('Last')], { order: 7 })]);
  const target = f.find(state, 'list_item', 'TitleNested'), after = f.reversible(state, f.convertBlock(state, target, 'h2'));
  assert.equal(after.doc.childCount, 4); assert.equal(after.doc.child(0).attrs.order, 7); assert.equal(after.doc.child(1).type.name, 'heading');
  assert.equal(after.doc.child(1).attrs.level, 2); assert.equal(after.doc.child(1).firstChild.marks[0].type.name, 'strong'); assert.ok(after.doc.child(2).eq(nested)); assert.equal(after.doc.child(3).attrs.order, 9);
  for (const type of ['paragraph', 'bullet', 'task', 'blockquote']) { const result = f.reversible(state, f.convertBlock(state, target, type)); assert.equal(result.doc.textContent, state.doc.textContent); }
});

test('code conversion never silently discards inline math, images or nested blocks', async () => {
  const f = await fixture(); const math = f.n('math_inline', null, { value: 'x^2' });
  const state = f.state([f.n('paragraph', [f.schema.text('formula'), math]), f.n('image', null, { src: 'local.png', width: 320 }), f.n('blockquote', [f.p('one'), f.p('two')])]);
  assert.equal(f.convertBlock(state, f.find(state, 'paragraph', 'formula'), 'code_block'), null);
  assert.equal(f.convertBlock(state, f.find(state, 'image'), 'h2'), null);
  assert.equal(f.convertBlock(state, f.find(state, 'blockquote'), 'code_block'), null);
  const code = f.state([f.n('code_block', f.schema.text('line one\nline two'), { language: 'mermaid' })]);
  const paragraph = f.reversible(code, f.convertBlock(code, f.find(code, 'code_block'), 'paragraph'));
  assert.equal(paragraph.doc.firstChild.child(1).type.name, 'hardbreak');
  const roundtrip = f.reversible(paragraph, f.convertBlock(paragraph, f.find(paragraph, 'paragraph'), 'code_block')); assert.equal(roundtrip.doc.textContent, code.doc.textContent);
});

test('block styles cover only eligible text and clearing styles preserves links and code', async () => {
  const f = await fixture(), link = f.schema.marks.link.create({ href: 'https://example.com' });
  const state = f.state([f.n('blockquote', [f.n('paragraph', [f.schema.text('Link', [link]), f.schema.text(' plain')]), f.n('code_block', f.schema.text('raw'))])]);
  const target = f.find(state, 'blockquote'), bold = f.reversible(state, f.styleBlock(state, target, 'strong'));
  assert.ok(f.schema.marks.strong.isInSet(bold.doc.firstChild.firstChild.firstChild.marks)); assert.equal(bold.doc.firstChild.lastChild.firstChild.marks.length, 0);
  const cleared = f.reversible(bold, f.styleBlock(bold, f.find(bold, 'blockquote'), 'clear')); assert.ok(cleared.doc.eq(state.doc));
  assert.equal(f.styleBlock(state, f.find(state, 'code_block'), 'strong'), null);
});

test('table, image and code nodes move intact without flattening their attributes', async () => {
  const f = await fixture(), table = f.n('table', [f.n('table_row', [f.n('table_cell', [f.p('Cell')])])]);
  for (const node of [table, f.n('image', null, { src: 'a b.png', width: 450 }), f.n('code_block', f.schema.text('graph TD\nA-->B'), { language: 'mermaid' })]) {
    const state = f.state([node, f.p('Anchor')]), target = f.captureBlock(state, 0);
    const moved = f.reversible(state, f.moveBlock(state, target, state.doc.content.size)); assert.ok(moved.doc.lastChild.eq(node));
  }
});

test('plain block copy includes inline formula source and image descriptions instead of dropping atoms', async () => {
  const f = await fixture(), state = f.state([f.n('paragraph', [f.schema.text('Formula '), f.n('math_inline', null, { value: 'x^2' }), f.schema.text(' stays.')]), f.n('image', null, { src: 'local.png' })]);
  assert.equal(f.blockPlainText(state, f.find(state, 'paragraph')), 'Formula x^2 stays.');
  assert.equal(f.blockPlainText(state, f.find(state, 'image')), 'local.png');
});

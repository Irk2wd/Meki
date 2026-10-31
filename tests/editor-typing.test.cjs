const test = require('node:test');
const assert = require('node:assert/strict');
async function fixture(text = '', options = {}, code = false) {
  const { Schema } = await import('@milkdown/kit/prose/model');
  const { EditorState, TextSelection } = await import('@milkdown/kit/prose/state');
  const { history, undo, redo, undoDepth } = await import('@milkdown/kit/prose/history');
  const { typingPlugin } = await import('../src/editor-typing.ts');
  const { typingDefaults } = await import('../src/typing-rules.ts');
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, code_block: { content: 'text*', group: 'block', code: true }, text: { group: 'inline' }, math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: {} } } }, marks: { emphasis: {}, strong: {}, inlineCode: { code: true }, moye_sub: {}, moye_sup: {}, moye_highlight: {}, strike_through: {} } });
  let settings = { ...typingDefaults, ...options };
  const plugin = typingPlugin(() => settings);
  const state = EditorState.create({ schema, doc: schema.node('doc', null, schema.node(code ? 'code_block' : 'paragraph', null, text ? schema.text(text) : undefined)), plugins: [history(), plugin] });
  const view = { state, composing: false, dispatch(tr) { this.state = this.state.applyTransaction(tr).state; } };
  const select = (from, to = from) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).setMeta('addToHistory', false));
  return { view, plugin, schema, select, text: () => view.state.doc.textContent,
    input: value => plugin.props.handleTextInput(view, view.state.selection.from, view.state.selection.to, value),
    backspace: () => plugin.props.handleKeyDown(view, { key: 'Backspace' }),
    set: patch => { settings = { ...settings, ...patch }; },
    undo: () => undo(view.state, tr => view.dispatch(tr)), redo: () => redo(view.state, tr => view.dispatch(tr)), depth: () => undoDepth(view.state),
  };
}
test('visual paired insertion, skip and deletion track actual generated closers', async () => {
  const f = await fixture('', { typingAutoPair: 'on' });
  assert.equal(f.input('('), true); assert.equal(f.text(), '()'); assert.equal(f.view.state.selection.from, 2);
  assert.equal(f.input(')'), true); assert.equal(f.text(), '()'); assert.equal(f.view.state.selection.from, 3);
  f.select(2); assert.equal(f.backspace(), true); assert.equal(f.text(), '');
  f.undo(); assert.equal(f.text(), '()');
});
test('wrapping and Markdown marks retain selected text formatting and have isolated undo', async () => {
  const f = await fixture('word', { typingAutoPair: 'on', typingMarkdownPairs: true });
  f.select(1, 5); assert.equal(f.input('*'), true); assert.equal(f.text(), 'word'); assert.equal(f.view.state.doc.firstChild.firstChild.marks[0].type.name, 'emphasis');
  assert.equal(f.input('*'), true); assert.equal(f.view.state.doc.firstChild.firstChild.marks[0].type.name, 'strong');
  assert.equal(f.input('['), true); assert.equal(f.text(), '[word]');
  const selected = f.view.state.doc.nodeAt(2); assert.ok(selected.marks.some(mark => mark.type.name === 'strong'));
  assert.equal(f.depth(), 3); f.undo(); assert.equal(f.text(), 'word'); f.undo(); assert.equal(f.view.state.doc.firstChild.firstChild.marks[0].type.name, 'emphasis');
});
test('visual math wrapping creates a real math node and undo restores original prose', async () => {
  const f = await fixture('x^2', { typingMarkdownPairs: true }); f.select(1, 4);
  assert.equal(f.input('$'), true); assert.equal(f.view.state.doc.firstChild.firstChild.type.name, 'math_inline'); assert.equal(f.view.state.doc.firstChild.firstChild.attrs.value, 'x^2');
  f.undo(); assert.equal(f.text(), 'x^2');
});
test('visual smart rewrite excludes code blocks, code marks, math and IME composition', async () => {
  const f = await fixture('word', { typingSmartQuotes: true, typingAutoPair: 'on', typingMarkdownPairs: true });
  f.view.composing = true; assert.equal(f.input('"'), false); f.view.composing = false;
  f.view.dispatch(f.view.state.tr.addMark(1, 5, f.schema.marks.inlineCode.create())); f.select(1, 5); assert.equal(f.input('*'), false);
  const code = await fixture('word', { typingSmartQuotes: true }, true); assert.equal(code.input('"'), false);
  const pending = await fixture('$x=', { typingSmartQuotes: true }); pending.select(4); assert.equal(pending.input('"'), false);
});
test('pair tracking follows intervening edits without skipping pre-existing punctuation', async () => {
  const f = await fixture('', { typingAutoPair: 'on' }); f.input('(');
  f.view.dispatch(f.view.state.tr.insertText('text', 2)); f.select(6); assert.equal(f.input(')'), true); assert.equal(f.text(), '(text)');
  const old = await fixture('()', { typingAutoPair: 'on' }); old.select(2); assert.equal(old.input(')'), false); assert.equal(old.backspace(), false);
  const replaced = await fixture('', { typingAutoPair: 'on' }); replaced.input('(');
  replaced.view.dispatch(replaced.view.state.tr.insertText(')', 2, 3)); replaced.select(2);
  assert.equal(replaced.input(')'), false, 'a replacement closer is no longer the generated token');
});
test('turning enhancement off changes behavior immediately without rewriting existing text', async () => {
  const f = await fixture('word-', { typingSmartDashes: true, typingAutoPair: 'on' }); f.select(6); f.input('-'); assert.equal(f.text(), 'word—');
  f.set({ typingSmartDashes: false, typingAutoPair: 'off' }); assert.equal(f.input('('), false); assert.equal(f.text(), 'word—');
  f.undo(); assert.equal(f.text(), 'word-');
  const paired = await fixture('', { typingAutoPair: 'on' }); paired.input('('); paired.set({ typingAutoPair: 'off' });
  assert.equal(paired.backspace(), false); assert.equal(paired.input(')'), false);
  paired.view.dispatch(paired.view.state.tr.insertText(')', 2, 3)); paired.select(2); paired.set({ typingAutoPair: 'on' });
  assert.equal(paired.input(')'), false); assert.equal(paired.backspace(), false, 'reenabling does not revive a replaced closer');
});

test('mixed math selections and paragraph-spanning selections stay outside the prose input rules', async () => {
  const f = await fixture('', { typingAutoPair: 'on', typingMarkdownPairs: true });
  f.view.dispatch(f.view.state.tr.replaceWith(1, 1, [f.schema.text('a'), f.schema.nodes.math_inline.create({ value: 'x' }), f.schema.text('b')]));
  f.select(1, 4); assert.equal(f.input('*'), false); assert.equal(f.input('('), false);
  f.view.dispatch(f.view.state.tr.replaceWith(0, f.view.state.doc.content.size, [f.schema.node('paragraph', null, f.schema.text('one')), f.schema.node('paragraph', null, f.schema.text('two'))]));
  f.select(1, 9); assert.equal(f.input('('), false); assert.equal(f.input('$'), false);
});

test('composition DOM lifecycle blocks punctuation even before the view composing flag updates', async () => {
  const f = await fixture('', { typingAutoPair: 'on', typingSmartQuotes: true });
  f.plugin.props.handleDOMEvents.compositionstart(); assert.equal(f.input('('), false);
  f.plugin.props.handleDOMEvents.compositionend(); assert.equal(f.input('"'), false);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(f.input('"'), true); assert.equal(f.text(), '“”');
});

test('generated closers follow UTF-16 positions through emoji and CJK input', async () => {
  const f = await fixture('', { typingAutoPair: 'on' }); f.input('（');
  f.view.dispatch(f.view.state.tr.insertText('🖋️中文', 2)); f.select(7);
  assert.equal(f.input('）'), true); assert.equal(f.text(), '（🖋️中文）'); assert.equal(f.view.state.selection.from, 8);
});
test('source preferences configure the existing CodeMirror bracket handler without rewriting source', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { basicSetup } = await import('codemirror');
  const { markdown } = await import('@codemirror/lang-markdown');
  const { insertBracket, deleteBracketPair } = await import('@codemirror/autocomplete');
  const { EditorTyping } = await import('../src/editor-typing.ts');
  const source = { state: null, dispatch(spec) { this.state = this.state.update(spec).state; } };
  const typing = new EditorTyping(() => source);
  source.state = EditorState.create({ doc: '', extensions: [basicSetup, markdown(), typing.sourceExtension] });
  assert.equal(insertBracket(source.state, '(').state.doc.toString(), '()');
  const oldTab = source.state;
  typing.updateSettings({ typingAutoPair: 'off', typingSmartQuotes: true, typingSmartDashes: true });
  assert.equal(insertBracket(source.state, '('), null); assert.equal(source.state.doc.toString(), '');
  source.state = oldTab; typing.sourceRestored();
  assert.equal(insertBracket(source.state, '('), null, 'restoring an inactive tab must reapply the current global preference');
  source.state = EditorState.create({ doc: '"raw" -- $x$', extensions: [basicSetup, markdown(), typing.sourceExtension] });
  assert.equal(insertBracket(source.state, '('), null); assert.equal(source.state.doc.toString(), '"raw" -- $x$');
  typing.updateSettings({ typingAutoPair: 'default' });
  source.dispatch({ selection: { anchor: source.state.doc.length } });
  assert.ok(insertBracket(source.state, '(')); assert.equal(source.state.doc.toString(), '"raw" -- $x$');
  source.state = EditorState.create({ doc: '', extensions: [basicSetup, markdown(), typing.sourceExtension] });
  source.state = insertBracket(source.state, '(').state;
  typing.updateSettings({ typingAutoPair: 'off' });
  assert.equal(deleteBracketPair(source), false, 'turning pairing off disables deletion of an already generated pair');
  assert.equal(insertBracket(source.state, ')'), null, 'turning pairing off disables skipping its generated closer');
  source.dispatch({ changes: { from: 1, to: 2, insert: '' }, selection: { anchor: 1 } });
  source.dispatch({ changes: { from: 1, insert: ')' }, selection: { anchor: 1 } });
  typing.updateSettings({ typingAutoPair: 'on' }); assert.equal(insertBracket(source.state, ')') === null, true, 'new punctuation must not recover a deleted token');
});

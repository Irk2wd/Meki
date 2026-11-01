const test = require('node:test');
const assert = require('node:assert/strict');
const rules = import('../src/typing-rules.ts');
const point = (text, input, from = text.length, to = from, extra = {}) => ({ text, input, from, to, ...extra });

test('typing defaults preserve existing editors instead of enabling new rewrites', async () => {
  const { typingDefaults, typingAction } = await rules;
  assert.deepEqual(typingDefaults, { typingAutoPair: 'default', typingMarkdownPairs: false, typingSmartQuotes: false, typingSmartDashes: false });
  for (const key of ['(', '"', '*', '-', "'"]) assert.equal(typingAction(point('', key)), null);
});
test('enabled pairing inserts parentheses and CJK pairs only in suitable contexts', async () => {
  const { typingDefaults, typingAction } = await rules, on = { ...typingDefaults, typingAutoPair: 'on' };
  assert.deepEqual(typingAction(point('', '('), on), { kind: 'wrap', from: 0, to: 0, pair: { open: '(', close: ')', trigger: ')' } });
  assert.equal(typingAction(point('word', '(', 0), on), null);
  assert.equal(typingAction(point('', '「'), on).pair.close, '」');
  assert.equal(typingAction(point('can', "'"), on), null);
});
test('selection wrapping preserves its bounds and supports formatted text in the adapter', async () => {
  const { typingDefaults, typingAction } = await rules;
  assert.deepEqual(typingAction(point('a selected b', '[', 2, 10), { ...typingDefaults, typingAutoPair: 'on' }), { kind: 'wrap', from: 2, to: 10, pair: { open: '[', close: ']', trigger: ']' } });
});
test('only plugin-generated closing tokens can be skipped or deleted as a pair', async () => {
  const { typingDefaults, typingAction, pairedBackspace } = await rules, on = { ...typingDefaults, typingAutoPair: 'on' }, tracked = { open: '(', close: ')', trigger: ')' };
  assert.deepEqual(typingAction(point('()', ')', 1, 1, { tracked }), on), { kind: 'skip', cursor: 2 });
  assert.equal(typingAction(point('()', ')', 1), on), null);
  assert.deepEqual(pairedBackspace(point('()', '', 1, 1, { tracked }), on), { kind: 'replace', from: 0, to: 2, text: '', cursor: 0 });
  assert.equal(pairedBackspace(point('()', '', 1), on), null);
});
test('smart quotes distinguish opening quotes and apostrophes without rewriting surrounding prose', async () => {
  const { typingDefaults, typingAction } = await rules, on = { ...typingDefaults, typingSmartQuotes: true };
  assert.equal(typingAction(point('', '"'), on).text, '“');
  assert.equal(typingAction(point('quoted', '"'), on).text, '”');
  assert.equal(typingAction(point('It', "'"), on).text, '’');
  assert.equal(typingAction(point('a ', "'"), on).text, '‘');
});
test('smart quotes cooperate with paired closing and paired deletion', async () => {
  const { typingDefaults, typingAction } = await rules, on = { ...typingDefaults, typingAutoPair: 'on', typingSmartQuotes: true };
  const first = typingAction(point('', '"'), on); assert.equal(first.pair.open, '“'); assert.equal(first.pair.close, '”');
  assert.deepEqual(typingAction(point('“”', '"', 1, 1, { tracked: first.pair }), on), { kind: 'skip', cursor: 2 });
});
test('smart dashes avoid Markdown thematic-break and list prefixes', async () => {
  const { typingDefaults, typingAction } = await rules, on = { ...typingDefaults, typingSmartDashes: true };
  assert.deepEqual(typingAction(point('word-', '-'), on), { kind: 'replace', from: 4, to: 5, text: '—', cursor: 5 });
  for (const text of ['-', '--', '  -', '    --']) assert.equal(typingAction(point(text, '-'), on), null);
});
test('Markdown selection symbols become semantic marks or an editable math node', async () => {
  const { typingDefaults, typingAction } = await rules, on = { ...typingDefaults, typingMarkdownPairs: true };
  const pairs = [['*', 'emphasis'], ['**', 'strong'], ['_', 'emphasis'], ['`', 'inlineCode'], ['~', 'meki_sub'], ['~~', 'strike_through'], ['^', 'meki_sup'], ['=', 'meki_highlight']];
  for (const [key, mark] of pairs) assert.deepEqual(typingAction(point('hello', key, 0, 5), on), { kind: 'mark', from: 0, to: 5, mark });
  assert.deepEqual(typingAction(point('x^2', '$', 0, 3), on), { kind: 'math', from: 0, to: 3, tex: 'x^2' });
  assert.equal(typingAction(point('two words', '^', 0, 9), on), null);
});
test('composition, protected code/math content and invalid ranges are never transformed', async () => {
  const { typingDefaults, typingAction } = await rules, on = { ...typingDefaults, typingAutoPair: 'on', typingSmartQuotes: true, typingSmartDashes: true, typingMarkdownPairs: true };
  for (const extra of [{ composing: true }, { protected: true }]) for (const input of ['(', '"', '*']) assert.equal(typingAction(point('word-', input, 0, 4, extra), on), null);
  assert.equal(typingAction(point('a', '(', 4), on), null);
  assert.equal(typingAction(point('a', '(', -1), on), null);
});
test('unfinished inline TeX suppresses rewriting while escaped dollars and completed expressions do not', async () => {
  const { typingDefaults, typingAction, insidePendingMath } = await rules, on = { ...typingDefaults, typingSmartQuotes: true };
  assert.equal(typingAction(point('$x=', '"'), on), null);
  assert.equal(insidePendingMath('cost \\$5', 8), false);
  assert.equal(typingAction(point('$x$ ', '"'), on).text, '“');
});

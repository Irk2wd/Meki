const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore, validateSettings, DEFAULT_SETTINGS } = require('../electron/file-store.cjs');
const options = (query, patch = {}) => ({ query, regex: false, wholeWord: false, caseSensitive: false, ...patch });
const segment = text => [{ id: 0, text }];

test('literal matching escapes regex, preserves original UTF-16 offsets and respects case', async () => {
  const { searchText } = await import('../src/search.ts');
  const source = '🖋️ A+B a+b AAB';
  assert.deepEqual(searchText(segment(source), options('a+b')).matches.map(({ from, to }) => source.slice(from, to)), ['A+B', 'a+b']);
  assert.deepEqual(searchText(segment(source), options('a+b', { caseSensitive: true })).matches.map(match => match.from), [8]);
  const punctuation = '.*$[]' + String.fromCharCode(92);
  assert.equal(searchText(segment(punctuation), options(punctuation)).matches.length, 1);
});

test('whole-word boundaries support Unicode letters, marks and surrogate characters', async () => {
  const { searchText } = await import('../src/search.ts');
  assert.equal(searchText(segment('cat scatter cat_ cat2 cat. 猫cat cat猫'), options('cat', { wholeWord: true })).matches.length, 2);
  assert.equal(searchText(segment('猫 中文 猫咪 (猫) 🖋猫'), options('猫', { wholeWord: true })).matches.length, 3);
  assert.equal(searchText(segment('e\u0301 e'), options('e', { wholeWord: true })).matches.length, 1);
  assert.equal(searchText(segment('αβ α'), options('α', { wholeWord: true })).matches.length, 1);
});

test('regex validates, captures named groups and never joins separate blocks', async () => {
  const { searchText } = await import('../src/search.ts');
  assert.match(searchText(segment('hello'), options('[', { regex: true })).error, /无效/);
  const result = searchText([{ id: 4, text: 'item-42' }, { id: 8, text: 'item-7' }], options('(?<kind>item)-(\\d+)', { regex: true }));
  assert.deepEqual(result.matches.map(match => [match.segment, match.groups.kind, match.captures[1]]), [[4, 'item', '42'], [8, 'item', '7']]);
  assert.equal(searchText([{ id: 0, text: 'first' }, { id: 1, text: 'second' }], options('first.*second', { regex: true })).matches.length, 0);
});

test('zero-width expressions advance by codepoint and matching is explicitly capped', async () => {
  const { searchText, MAX_MATCHES } = await import('../src/search.ts');
  assert.deepEqual(searchText(segment('😀a'), options('(?=.)', { regex: true })).matches.map(match => match.from), [0, 2]);
  assert.deepEqual(searchText(segment('a\nb'), options('^|$', { regex: true })).matches.map(match => match.from), [0, 1, 2, 3]);
  const result = searchText(segment('a'.repeat(MAX_MATCHES + 1)), options('a'));
  assert.equal(result.matches.length, MAX_MATCHES); assert.equal(result.truncated, true);
  assert.match(searchText(segment('a'), options('a'.repeat(4097))).error, /4096/);
});

test('regex replacement matches JavaScript capture and literal-dollar semantics', async () => {
  const { searchText, replacementText } = await import('../src/search.ts');
  const source = 'prefix item-42 suffix', query = '(?<kind>item)-(\\d+)', replacement = "$<kind> $2 $& $$ $12 $99 $` $' $<absent>";
  const [match] = searchText(segment(source), options(query, { regex: true })).matches;
  const actual = source.slice(0, match.from) + replacementText(replacement, match, source, true) + source.slice(match.to);
  assert.equal(actual, source.replace(new RegExp(query, 'u'), replacement));
  assert.equal(replacementText('$1 $$', match, source, false), '$1 $$');
  const [optional] = searchText(segment('b'), options('(a)?b', { regex: true })).matches;
  assert.equal(replacementText('$1x', optional, 'b', true), 'x');
});

test('selection word count handles CJK characters, words and punctuation', async () => {
  const { countWords } = await import('../src/search.ts');
  assert.equal(countWords('中文 two words'), 4);
  assert.equal(countWords('we’re state-of-the-art 🖋️'), 2);
  assert.equal(countWords(' \n '), 0);
});

test('writing preferences default off, validate types and survive older profiles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-writing-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ settings: { theme: 'linen', fontSize: 20 } }));
  const store = new FileStore(root); await store.init();
  for (const key of ['typewriter', 'paragraphFocus', 'spellcheck']) {
    assert.equal(DEFAULT_SETTINGS[key], false); assert.equal(store.metadata.settings[key], false);
    assert.throws(() => validateSettings({ [key]: 'true' }), /Invalid setting/);
  }
  await store.updateSettings({ typewriter: true, paragraphFocus: true, spellcheck: true });
  const restored = new FileStore(root); await restored.init();
  assert.equal(restored.metadata.settings.theme, 'linen');
  for (const key of ['typewriter', 'paragraphFocus', 'spellcheck']) assert.equal(restored.metadata.settings[key], true);
});

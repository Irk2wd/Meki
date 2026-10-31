'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { shortcutCatalog, defaultBinding, bindings, normalizeBinding, reservedBinding, validateBindings, eventBinding, commandFor, accelerator } = require('../electron/shortcuts.mjs');
const { ClosedDocuments, CLOSED_LIMITS } = require('../electron/closed-documents.mjs');
const { FileStore, validateSettings } = require('../electron/file-store.cjs');
test('default shortcuts have unique bindings and one platform-specific mapping for menus and renderer', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(validateBindings({}, platform), {});
    const values = Object.values(bindings({}, platform)).filter(Boolean); assert.equal(new Set(values).size, values.length);
    assert.equal(accelerator(defaultBinding('save', platform), platform), platform === 'darwin' ? 'Cmd+S' : 'Ctrl+S');
    assert.equal(defaultBinding('replace', platform), platform === 'darwin' ? 'Mod+Alt+F' : 'Mod+H');
    for (const item of shortcutCatalog) assert.ok(item.id && item.label);
  }
});
test('custom chords normalize modifiers, disable defaults and reject collisions with untouched commands', () => {
  assert.equal(normalizeBinding('Shift+Mod+J'), 'Mod+Shift+J');
  assert.deepEqual(validateBindings({ save: 'Shift+Mod+J', open: null }), { save: 'Mod+Shift+J', open: null });
  assert.equal(bindings({ save: null }).save, null);
  assert.throws(() => validateBindings({ save: 'Mod+O' }), /冲突/);
  assert.doesNotThrow(() => validateBindings({ open: null, save: 'Mod+O' }));
  assert.throws(() => validateBindings({ unknown: null }), /未知/);
  for (const invalid of ['', 'N', 'Alt+N', 'Mod+Mod+N', 'Mod+Escape', 'Mod+ArrowLeft', 'Super+N', '<script>', 1, [], {}]) assert.throws(() => normalizeBinding(invalid));
});
test('ordinary edit commands, platform system shortcuts, zoom and unsupported navigation chords are protected', () => {
  for (const key of ['Mod+A', 'Mod+B', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Y', 'Mod+Shift+Z', 'Mod+Q', 'Mod+R', 'F11', 'Alt+F4', 'Mod+Minus', 'Mod+Equal', 'Mod+0', 'Mod+Shift+I', 'Mod+Alt+1', 'Mod+BracketLeft']) {
    assert.equal(reservedBinding(key, 'win32'), true, key); assert.throws(() => validateBindings({ math: key }, 'win32'), /保留/);
  }
  assert.equal(reservedBinding('Mod+H', 'darwin'), true); assert.equal(reservedBinding('Mod+H', 'win32'), false);
  assert.throws(() => validateBindings({ math: 'Mod+H' }, 'darwin'), /保留/);
});
test('renderer and Electron keyboard shapes resolve identically, with platform modifiers and exact combinations', () => {
  assert.equal(commandFor({ code: 'KeyS', ctrlKey: true }, {}, 'win32'), 'save');
  assert.equal(commandFor({ code: 'KeyS', control: true }, {}, 'win32'), 'save');
  assert.equal(commandFor({ code: 'KeyS', metaKey: true }, {}, 'darwin'), 'save');
  assert.equal(commandFor({ code: 'KeyS', ctrlKey: true }, {}, 'darwin'), null);
  assert.equal(commandFor({ code: 'KeyS', ctrlKey: true, altKey: true }, {}, 'win32'), null);
  assert.equal(commandFor({ code: 'KeyS', ctrlKey: true }, { save: 'Mod+J' }, 'win32'), null);
  assert.equal(commandFor({ code: 'KeyJ', ctrlKey: true }, { save: 'Mod+J' }, 'win32'), 'save');
  assert.equal(commandFor({ code: 'Slash', ctrlKey: true, key: '?' }, {}, 'win32'), 'source');
  assert.equal(eventBinding({ code: 'ShiftLeft' }, 'win32'), null);
  assert.equal(eventBinding({ code: 'KeyN', metaKey: true }, 'win32'), null);
});
test('shortcut settings survive FileStore restart and invalid replacements leave the current mapping intact', async () => {
  const root = await fs.mkdtemp(path.join(__dirname, '..', 'test-results', 'shortcuts-store-'));
  const store = new FileStore(root); await store.init(); await store.updateSettings({ shortcuts: { save: 'Mod+J', math: 'Mod+Shift+M' }, fontSize: 23 });
  const restored = new FileStore(root); await restored.init(); assert.deepEqual(restored.metadata.settings.shortcuts, { save: 'Mod+J', math: 'Mod+Shift+M' }); assert.equal(restored.metadata.settings.fontSize, 23);
  assert.throws(() => validateSettings({ shortcuts: { save: 'Mod+O' } }), /冲突/);
  assert.equal(store.metadata.settings.shortcuts.save, 'Mod+J');
});
const record = (text, path = null) => ({ document: { path, name: 'note.md', content: text, revision: null }, savedContent: '', dirty: true, mode: 'source', scroll: 123, sourceScroll: 456 });
test('closed document history is LIFO, clones buffers and excludes empty unmodified scratch tabs', () => {
  const stack = new ClosedDocuments(), original = record('before'); stack.push([original, { ...record(''), dirty: false }]);
  original.document.content = 'after'; assert.equal(stack.length, 1); assert.equal(stack.peek().document.content, 'before');
  assert.equal(stack.peek().mode, 'source'); assert.equal(stack.peek().sourceScroll, 456); assert.equal(stack.pop().scroll, 123); assert.equal(stack.bytes, 0); assert.equal(stack.pop(), undefined);
});
test('closed document history evicts oldest entries at 20 records and a strict UTF-8 32 MiB content/baseline budget', () => {
  const stack = new ClosedDocuments(); stack.push(Array.from({ length: 25 }, (_, i) => record(String(i)))); assert.equal(stack.length, 20); assert.equal(stack.pop().document.content, '24');
  const sized = new ClosedDocuments(), big = record('中文'.repeat(1024 * 1024)); big.savedContent = big.document.content;
  sized.push([big, big, big]); assert.equal(sized.length, 2); assert.ok(sized.bytes <= CLOSED_LIMITS.bytes);
  sized.push([record('x'.repeat(CLOSED_LIMITS.bytes + 1))]); assert.equal(sized.length, 2); assert.ok(sized.bytes <= CLOSED_LIMITS.bytes);
  assert.equal(new ClosedDocuments().length, 0, 'a new window or process has no closed history');
});

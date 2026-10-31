const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileStore, DEFAULT_SETTINGS, validateSettings } = require('../electron/file-store.cjs');

test('typing preferences migrate conservatively, validate IPC and persist independent changes', async t => {
  const output = path.resolve(__dirname, '../test-results'); await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'typing-settings-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ settings: { theme: 'night', typingSmartQuotes: 'yes', typingAutoPair: 'invalid' } }));
  const store = new FileStore(profile); await store.init();
  assert.equal(store.metadata.settings.theme, 'night');
  const { typingDefaults } = await import('../src/typing-rules.ts');
  for (const [key, value] of Object.entries(typingDefaults)) {
    assert.equal(DEFAULT_SETTINGS[key], value); assert.equal(store.metadata.settings[key], value);
  }
  for (const patch of [{ typingAutoPair: true }, { typingAutoPair: 'yes' }, { typingMarkdownPairs: 1 }, { typingSmartQuotes: 'yes' }, { typingSmartDashes: null }]) assert.throws(() => validateSettings(patch), /Invalid setting/);
  await Promise.all([store.updateSettings({ typingAutoPair: 'off' }), store.updateSettings({ typingSmartQuotes: true, typingSmartDashes: true, typingMarkdownPairs: true })]);
  const reopened = new FileStore(profile); await reopened.init();
  assert.equal(reopened.metadata.settings.theme, 'night');
  assert.deepEqual(Object.fromEntries(Object.keys(typingDefaults).map(key => [key, reopened.metadata.settings[key]])), { typingAutoPair: 'off', typingMarkdownPairs: true, typingSmartQuotes: true, typingSmartDashes: true });
});

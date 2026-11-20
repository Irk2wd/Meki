const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { builtinThemes, resolveTheme, validateThemePackage } = require('../electron/theme-format.mjs');
const { FileStore } = require('../electron/file-store.cjs');
const { writingAppearance } = require('../src/appearance.ts');
const example = require('../docs/mist.meki-theme.json');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const texture = bytes => `data:image/png;base64,${bytes.toString('base64')}`;

test('built-in designs and the published example follow the same styling rules', () => {
  assert.deepEqual(validateThemePackage(example), example);
  for (const theme of builtinThemes) {
    const manifest = { ...theme, id: `example-${theme.id}` };
    assert.deepEqual(validateThemePackage(manifest), manifest);
  }
  assert.equal(resolveTheme('cyber').base, 'night');
  assert.equal(resolveTheme(example.id, [example]).palette['logo-ink'], resolveTheme('paper').palette['logo-ink']);
  const css = writingAppearance({ theme: example.id, installedThemes: [example], customCss: 'h1{color:rebeccapurple}' });
  assert.match(css, /\.meki-document\.meki-document h1\{color:var\(--accent\);border-bottom:2px solid var\(--accent\)/);
  assert.ok(css.indexOf('rebeccapurple') > css.indexOf('border-bottom:2px solid var(--accent)'));
});

test('theme packages reject resource loads, invalid schema, reserved ids and control styling', () => {
  const invalid = [
    { version: 2 },
    { id: 'cyber' },
    { id: '../mist' },
    { script: 'true' },
    { palette: { bg: 'white; color: red' } },
    { background: { placement: 'unsupported', image: 'linear-gradient(#fff, #000)' } },
    { background: { image: 'url(https://example.test/texture.png)' } },
    { background: { image: 'linear-gradient(#fff, #000), url(file:///texture.png)' } },
    { background: { image: 'data:image/svg+xml;base64,PHN2Zz4=' } },
    { background: { image: 'linear-gradient(#fff, var(--private))' } },
    { styles: { '.titlebar': { color: 'red' } } },
    { styles: { heading: { position: 'fixed' } } },
    { styles: { heading: { color: 'rgb(0 0 0' } } },
    { styles: { heading: { color: 'red} body {color:blue' } } },
    { styles: { heading: { color: "red'" } } },
    { styles: { heading: { color: 'u\\72l(pixel)' } } },
    { styles: { heading: { color: 'u/**/rl(pixel)' } } },
    { styles: { heading: { color: 'linear-gradient(#fff,#000),url(pixel)' } } },
    { styles: { heading: { color: 'attr(data-secret)' } } },
  ];
  for (const changes of invalid) assert.throws(() => validateThemePackage({ ...example, ...changes }), TypeError, JSON.stringify(changes));
});

test('a self-contained texture must be a bounded static PNG', () => {
  const background = { image: texture(png), size: '100px 100px' };
  assert.deepEqual(validateThemePackage({ ...example, background }).background, background);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(1025, 16);
  const animated = Buffer.from(png);
  animated.write('acTL', 37, 'ascii');
  for (const bytes of [oversized, animated, png.subarray(0, -1), Buffer.from('hello')]) {
    assert.throws(() => validateThemePackage({ ...example, background: { image: texture(bytes) } }), /background\.image/);
  }
});

test('import replaces matching ids atomically, restores across restart, and removes only the local copy', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-themes-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const file = path.join(root, 'journal.meki-theme.json');
  await fs.writeFile(file, JSON.stringify(example));
  await Promise.all([store.installThemePackage(file), store.updateSettings({ fontSize: 22 })]);
  assert.equal(store.metadata.settings.theme, example.id);
  await fs.writeFile(file, JSON.stringify({ ...example, base: 'linen' }));
  await store.installThemePackage(file);
  await fs.writeFile(file, JSON.stringify({ ...example, version: 2 }));
  await assert.rejects(store.installThemePackage(file));
  await assert.rejects(store.updateSettings({ installedThemes: [] }));
  const reopened = new FileStore(root);
  await reopened.init();
  assert.equal(reopened.metadata.settings.theme, example.id);
  assert.equal(reopened.metadata.settings.fontSize, 22);
  assert.deepEqual(reopened.metadata.settings.installedThemes, [{ ...example, base: 'linen' }]);
  await reopened.removeThemePackage(example.id);
  assert.equal(reopened.metadata.settings.theme, 'linen');
  assert.deepEqual(reopened.metadata.settings.installedThemes, []);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
});

test('one broken saved theme falls back to paper without losing the rest of the library', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meki-themes-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const broken = { ...example, id: 'broken-theme', background: { image: 'url(file:///texture.png)' } };
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ settings: { theme: broken.id, installedThemes: [broken, example], fontSize: 20 } }));
  const store = new FileStore(root);
  await store.init();
  assert.equal(store.metadata.settings.theme, 'paper');
  assert.equal(store.metadata.settings.fontSize, 20);
  assert.deepEqual(store.metadata.settings.installedThemes, [example]);
  await store.updateSettings({ theme: example.id });
  assert.equal(store.metadata.settings.theme, example.id);
});

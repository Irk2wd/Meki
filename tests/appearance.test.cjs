'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCustomCss, writingAppearance, writingFont } = require('../src/appearance.ts');
const writingFonts = require('../electron/writing-fonts.json');
const { validateSettings } = require('../electron/file-store.cjs');
const { fontGroups } = require('../src/local-fonts.ts');

test('every writing preset survives settings validation and uses the same fallback stack for reading and exporting', () => {
  for (const [font, {family}] of Object.entries(writingFonts)) {
    const settings = validateSettings({font});
    assert.equal(writingFont(settings), family);
    for (const exporting of [false, true]) assert.ok(writingAppearance(settings, {exporting}).includes(`--body-font:${family};`));
    assert.equal(writingFont({...settings, fontFamily:'Cafe\u0301'}), `"Cafe\u0301",${family}`);
  }
  assert.throws(() => validateSettings({font:'toString'}));
});

test('local font filters can combine Han coverage, design style and fixed pitch from one face', async () => {
  const bytes = Buffer.alloc(142), os2 = 44, post = 126;
  bytes.writeUInt16BE(2, 4);
  bytes.write('OS/2',12); bytes.writeUInt32BE(os2,20); bytes.writeUInt32BE(82,24);
  bytes.write('post',28); bytes.writeUInt32BE(post,36); bytes.writeUInt32BE(16,40);
  bytes.writeUInt32BE(1 << 27,os2+46); bytes[os2+32] = 2; bytes[os2+33] = 11;
  bytes.writeUInt32BE(1,post+12);
  let reads = 0;
  const family = {face:{blob:async () => { reads++; return new Blob([bytes]); }}};
  const [first, second] = await Promise.all([fontGroups(family), fontGroups(family)]);
  assert.deepEqual(first.sort(), ['han','mono','sans']); assert.equal(second, family.groups);
  assert.equal(reads, 1);
  assert.deepEqual(await fontGroups({face:{blob:async () => new Blob([bytes.subarray(0, 40)])}}), []);
});

test('a CJK range flag from a symbol face does not qualify it for the Han reading filter', async () => {
  async function groupsFor(format, last) {
    const cmap = Buffer.alloc(44);
    cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(12, 10); // One Unicode encoding, subtable at 12.
    const sub = cmap.subarray(12);
    sub.writeUInt16BE(format);
    if (format === 4) {
      sub.writeUInt16BE(32, 2); sub.writeUInt16BE(4, 6);
      sub.writeUInt16BE(last, 14); sub.writeUInt16BE(0xffff, 16);
      sub.writeUInt16BE(0x4e00, 20); sub.writeUInt16BE(0xffff, 22); sub.writeUInt16BE(1, 26);
    } else {
      sub.writeUInt32BE(28, 4); sub.writeUInt32BE(1, 12);
      sub.writeUInt32BE(0x4e00, 16); sub.writeUInt32BE(last, 20); sub.writeUInt32BE(1, 24);
    }
    const header = Buffer.alloc(44), metrics = Buffer.alloc(50);
    header.writeUInt16BE(2, 4); header.write('OS/2', 12); header.writeUInt32BE(44, 20); header.writeUInt32BE(metrics.length, 24);
    header.write('cmap', 28); header.writeUInt32BE(44 + metrics.length, 36); header.writeUInt32BE(cmap.length, 40);
    metrics.writeUInt32BE(1 << 27, 46);
    return fontGroups({face:{blob:async () => new Blob([header, metrics, cmap])}});
  }
  for (const format of [4, 12]) {
    assert.ok((await groupsFor(format, 0x9fff)).includes('han'));
    assert.ok(!(await groupsFor(format, 0x4e2d)).includes('han'));
  }
});

test('custom theme typography is scoped to the document with its own selector aliases', () => {
  const css = normalizeCustomCss('body { color: #234; } .meki-document h1, .ProseMirror h2 { font-size: 2em; } @media print { p {line-height:1.5} }');
  assert.match(css, /\.meki-document:is\(\.meki-document\)/);
  assert.match(css, /\.meki-document :is\(\.meki-document h1\)/);
  assert.match(css, /@media print/);
  assert.match(css, /font-size: 2em/);
});
test('document root aliases target the active editor or export scope', () => {
  const source = '#write h1, .meki-document h2, body p, .ProseMirror blockquote { color: #123456; }';
  const css = normalizeCustomCss(source, '.document-export');
  assert.doesNotMatch(css, /#write|\.meki-document|\.ProseMirror/);
  for (const element of ['h1', 'h2', 'p', 'blockquote']) assert.ok(css.includes(`.document-export ${element}`));
});
test('custom themes cannot load resources or style controls outside the document', () => {
  const css = normalizeCustomCss('@import "https://example.test/a.css"; @font-face {src:url(file:///secret)} .meki-document + .titlebar, body { position:fixed; color:red; background-image:url(https://example.test/x); --evil:u\\72l(https://example.test); cursor:url(x); font-family:var(--safe); }');
  assert.doesNotMatch(css, /@import|@font-face|url|position|background-image|cursor|--evil/);
  assert.match(css, /\.meki-document :is\(\.meki-document \+ \.titlebar\)/);
  assert.match(css, /color:\s*red/);
});
test('appearance preserves font, theme and font size across editor/export without forcing print colors', () => {
  const css = writingAppearance({ theme:'night', font:'sans',fontFamily:'Microsoft YaHei',fontSize:22,customCss:'h2{color:rebeccapurple}' });
  assert.match(css, /--writing-size:22px/); assert.match(css, /Microsoft YaHei/);
  assert.match(css, /--bg:#202521/); assert.match(css, /rebeccapurple/); assert.match(css, /@media print/);
  assert.doesNotMatch(css, /--(?:bg|text|accent|code-keyword):[^;]+!important/);
  assert.doesNotMatch(writingFont({font:'serif',fontFamily:'bad; color:red'}), /bad/);
});
test('invalid persisted CSS is ignored without blocking document appearance', () => {
  assert.throws(() => normalizeCustomCss('p{color:red'));
  assert.doesNotThrow(() => writingAppearance({customCss:'p{color:red'}));
  assert.throws(() => normalizeCustomCss('x'.repeat(256*1024+1)));
});

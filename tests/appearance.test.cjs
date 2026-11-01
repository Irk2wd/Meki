'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCustomCss, writingAppearance, writingFont } = require('../src/appearance.ts');

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

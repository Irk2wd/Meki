const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = import('../src/math-engine.ts');
const block = tex => ({ tex, display: true });
const inline = tex => ({ tex, display: false });
const noErrors = result => {
  assert.deepEqual(result.items.map(item => item.error), result.items.map(() => undefined));
  result.items.forEach(item => assert.match(item.html, /<svg\b/));
};

test('MathJax renders ordinary math, matrices and extended glyphs entirely offline', async () => {
  const { renderMathDocument } = await engine;
  const { mathjax } = await import('@mathjax/src/js/mathjax.js');
  const originalLoad = mathjax.asyncLoad;
  let requested = 0;
  mathjax.asyncLoad = () => { requested++; throw new Error('Network/font loading must not occur'); };
  try {
    const result = renderMathDocument([
      inline(String.raw`E=mc^2`),
      block(String.raw`\int_0^1 x^2\,dx=\frac{1}{3}`),
      block(String.raw`\begin{bmatrix} a & b \\ c & d \end{bmatrix}`),
      block(String.raw`\mathfrak{ABC} + \mathbb{R} + \mathcal{F} + \Longleftrightarrow + \text{éà Ω}`),
      block(String.raw`\color{red}{\boldsymbol{x} + \bm{A}} + \cancel{x}`),
    ]);
    noErrors(result);
    assert.equal(requested, 0);
    assert.ok(result.css.includes('mjx-container'));
    for (const item of result.items) {
      assert.match(item.html, /<path\b/);
      assert.doesNotMatch(item.html, /<script\b|<iframe\b|<image\b|<foreignObject\b|<use\b/i);
      assert.doesNotMatch(item.html, /(?:src|href)="(?:https?:|file:|data:|javascript:)/i);
    }
  } finally { mathjax.asyncLoad = originalLoad; }
});

test('document-wide labels resolve forward references and align rows with AMS numbering', async () => {
  const { renderMathDocument } = await engine;
  const result = renderMathDocument([
    inline(String.raw`\eqref{mass}`),
    block(String.raw`x=0`),
    block(String.raw`\begin{align} E&=mc^2\label{mass} \\ F&=ma\label{force} \end{align}`),
    inline(String.raw`\ref{force}`),
    block(String.raw`\begin{equation*} z=1 \end{equation*}`),
  ], { mathNumbering: 'ams' });
  noErrors(result);
  assert.equal(result.labels.mass.tag, '1');
  assert.equal(result.labels.force.tag, '2');
  assert.ok(result.items[0].html.includes(`#${encodeURIComponent(result.labels.mass.id)}`));
  assert.ok(result.items[2].html.includes(`id="${result.labels.mass.id}"`));
  assert.ok(result.items[3].html.includes(`#${encodeURIComponent(result.labels.force.id)}`));
  assert.doesNotMatch(result.items[1].html, /data-mml-node="mlabeledtr"/);
  assert.doesNotMatch(result.items[4].html, /data-mml-node="mlabeledtr"/);
});

test('none and all modes respect manual tags, nonumber and repeated formula occurrences', async () => {
  const { renderMathDocument } = await engine;
  const manual = renderMathDocument([
    inline(String.raw`\eqref{manual}`),
    block(String.raw`x=1\tag{A.2}\label{manual}`),
    block(String.raw`y=2`),
  ], { mathNumbering: 'none' });
  noErrors(manual);
  assert.equal(manual.labels.manual.tag, 'A.2');
  assert.doesNotMatch(manual.items[2].html, /data-mml-node="mlabeledtr"/);

  const automatic = renderMathDocument([
    block('x=1'), block('x=1'),
    block(String.raw`y=2\nonumber`),
    block(String.raw`z=3\label{last}`),
  ], { mathNumbering: 'all' });
  noErrors(automatic);
  assert.match(automatic.items[0].html, /id="meki-equation-1-1"/);
  assert.match(automatic.items[1].html, /id="meki-equation-2-2"/);
  assert.equal(automatic.labels.last.tag, '3');
});

test('document rerenders are deterministic and macros, numbering and labels do not leak', async () => {
  const { renderMathDocument, renderMath } = await engine;
  const expressions = [
    inline(String.raw`\eqref{a}`),
    block(String.raw`\newcommand{\localcmd}{x}\localcmd=1\label{a}`),
    inline(String.raw`\localcmd`),
  ];
  const first = renderMathDocument(expressions, { mathNumbering: 'all' });
  noErrors(first);
  assert.deepEqual(renderMathDocument(expressions, { mathNumbering: 'all' }), first);
  assert.match(renderMath(String.raw`\localcmd`).error, /Undefined control sequence/);
  assert.match(renderMath(String.raw`\eqref{a}`).error, /未找到/);
  const next = renderMathDocument([block(String.raw`y=2\label{a}`)], { mathNumbering: 'all' });
  assert.equal(next.labels.a.tag, '1');
});

test('mhchem includes chemistry arrows and bonds, with physics enabled only by choice', async () => {
  const { renderMathDocument, renderMath } = await engine;
  const chemistry = renderMathDocument([
    block(String.raw`\ce{2H2 + O2 -> 2H2O}`),
    block(String.raw`\ce{A <=>[k_1][k_{-1}] B}`),
    block(String.raw`\ce{N#N}`),
    inline(String.raw`\pu{1.2e3 kJ mol-1}`),
  ]);
  noErrors(chemistry);
  assert.doesNotMatch(chemistry.items.map(item => item.html).join(''), /data-mjx-error/);
  // mhchem v4 arrows use a separate font extension: accepting the TeX alone is
  // insufficient, since missing private glyphs otherwise fall back to empty text.
  assert.match(chemistry.items[0].html, /<path data-c="E429"/);
  assert.match(chemistry.items[1].html, /<path data-c="E40[234]"/);
  assert.doesNotMatch(chemistry.items[1].html, /<text\b/);
  assert.match(renderMath(String.raw`\dv{f}{x}`).error, /Undefined control sequence/);
  assert.equal(renderMath(String.raw`\dv{f}{x} + \bra{\psi}\ket{\phi}`, true, { mathPhysics: true }).error, undefined);
  assert.match(renderMath(String.raw`\dv{f}{x}`, true, { mathPhysics: false }).error, /Undefined control sequence/);
});

test('malformed TeX, duplicate labels and unresolved references report errors without losing source', async () => {
  const { renderMathDocument, renderMath } = await engine;
  assert.ok(renderMath(String.raw`\frac{1}{`).error);
  const duplicate = renderMathDocument([block(String.raw`x=1\label{same}`), block(String.raw`x=2\label{same}`)], { mathNumbering: 'all' });
  assert.equal(duplicate.items[0].error, undefined);
  assert.match(duplicate.items[1].error, /multiply defined/);
  assert.ok(duplicate.items[1].html.includes(String.raw`x=2\label{same}`));
  assert.match(renderMath(String.raw`\eqref{missing}`).error, /未找到/);
  assert.match(renderMath('x'.repeat(65537)).error, /64 KiB/);
  assert.ok(renderMath(String.raw`\def\x{\x}\x`).error);
});

test('TeX cannot load packages, inject HTML, open resources or turn labels into executable URLs', async () => {
  const { renderMathDocument, renderMath } = await engine;
  for (const tex of [
    String.raw`\require{https://example.com/x.js}`,
    String.raw`\href{javascript:alert(1)}{x}`,
    String.raw`\htmlClass{unsafe}{x}`,
    String.raw`\includegraphics{https://example.com/pixel}`,
    String.raw`\style{background:url(https://example.com/pixel)}{x}`,
    String.raw`\color{url(https://example.com/pixel)}x`,
    String.raw`\fcolorbox{url(https://example.com/pixel)}{red}{x}`,
    String.raw`\cancel[mathcolor="url(https://example.com/pixel)"]{x}`,
  ]) {
    const result = renderMath(tex);
    assert.ok(result.error, tex);
    assert.doesNotMatch(result.html, /<(?:script|img|iframe|image|foreignObject)\b/i);
    assert.doesNotMatch(result.html, /(?:src|href)="(?:https?:|javascript:)/i);
  }
  const escaped = renderMath(String.raw`\bad{<img src=x onerror="alert(1)">}`);
  assert.doesNotMatch(escaped.html, /<img/);
  assert.match(escaped.html, /&lt;img/);
  const labels = renderMathDocument([
    inline(String.raw`\eqref{constructor}+\ref{__proto__}`),
    block(String.raw`x=1\label{constructor}`),
    block(String.raw`x=2\label{__proto__}`),
  ], { mathNumbering: 'all' });
  noErrors(labels);
  assert.equal(labels.labels.constructor.tag, '1');
  assert.equal(labels.labels.__proto__.tag, '2');
});

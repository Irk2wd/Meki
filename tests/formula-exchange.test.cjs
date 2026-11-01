const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMathml, prepareWordMath } = require('../electron/word-math.cjs');
const engine = import('../src/math-engine.ts');
const expression = tex => ({ tex, display: true });
const simple = '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><msup><mi>x</mi><mn>2</mn></msup></math>';
const mathNode = { t: 'Math', c: [{ t: 'DisplayMath' }, 'x^{2}'] };
const image = () => ({ t: 'Image', c: [['', [], []], [{ t: 'Str', c: 'fallback' }], ['data:image/png;base64,original', '']] });
const wrapper = mathml => ({ t: 'Span', c: [['', [], [['meki-word-formula', '1'], ...(mathml ? [['meki-word-math', mathml]] : [])]], [image()]] });
const document = (...nodes) => ({ 'pandoc-api-version': [1, 23, 1, 2], meta: {}, blocks: [{ t: 'Para', c: nodes }] });
const result = (...nodes) => Buffer.from(JSON.stringify({ blocks: nodes.map((node, i) => ({ t: 'Div', c: [[`meki-equation-${i}`, [], []], [{ t: 'Plain', c: [node] }]] })) }));

test('MathML exchange preserves fractions, integrals, matrices and extended glyphs as structured offline math', async () => {
  const { renderMathDocument } = await engine;
  const items = renderMathDocument([
    expression(String.raw`\frac{a}{b}+\sqrt{x}`), expression(String.raw`\int_0^1 x^2\,dx`),
    expression(String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`), expression(String.raw`\mathbb{R}+\alpha`),
  ]).items;
  for (const item of items) {
    assert.equal(item.error, undefined); assert.match(item.mathml, /^<math xmlns=/);
    assert.equal(item.docxMathml, item.mathml); assert.equal(safeMathml(item.docxMathml), true);
    assert.doesNotMatch(item.mathml, /<svg|<script|data-mjx|(?:href|class|id)=/);
  }
  assert.match(items[0].mathml, /<mfrac>/); assert.match(items[2].mathml, /<mtable/);
});
test('exchange uses the compiled document to expand local macros and resolve forward references', async () => {
  const { renderMathDocument } = await engine;
  const items = renderMathDocument([
    expression(String.raw`\newcommand{\thing}{z}\thing`), { tex: String.raw`\eqref{later}`, display: false },
    expression(String.raw`x=1\tag{A}\label{later}`),
  ]).items;
  assert.match(items[0].mathml, /<mi>z<\/mi>/); assert.match(items[1].mathml, /A/);
  assert.doesNotMatch(items[1].mathml, /href=|MathJax_ref/); assert.equal(items[2].docxMathml, undefined);
});
test('special layout, equation labels, color and private font characters retain the SVG/PNG route', async () => {
  const { renderMathDocument } = await engine;
  const items = renderMathDocument([String.raw`\cancel{x}`, String.raw`\color{red}{x}`, String.raw`x\tag{1}`, String.raw`\ce{H2 -> H2}`].map(expression)).items;
  for (const item of items) { assert.equal(item.error, undefined); assert.match(item.html, /<svg/); assert.ok(item.mathml); assert.equal(item.docxMathml, undefined); }
});
test('invalid or forbidden TeX never exposes exchange data as a successful formula', async () => {
  const { renderMathDocument } = await engine;
  for (const tex of [String.raw`\frac{`, String.raw`\href{https://example.com}{x}`, String.raw`\ref{missing}`]) {
    const item = renderMathDocument([expression(tex)]).items[0]; assert.ok(item.error); assert.equal(item.mathml, undefined); assert.equal(item.docxMathml, undefined);
  }
});
test('Word MathML accepts bounded structural data and rejects active markup, special glyphs and malformed XML', () => {
  assert.equal(safeMathml(simple), true);
  for (const value of [null, '<math><mi>x</math>', '<math><mi>x</mi></math><math></math>', '<math><script>x</script></math>',
    '<math href="file:///private"><mi>x</mi></math>', '<math><mi style="color:red">x</mi></math>', '<math><annotation>x</annotation></math>',
    '<math><mi>&#xE429;</mi></math>', '<math><mi>\uE429</mi></math>', '<math><!--x--><mi>x</mi></math>', '<!DOCTYPE math><math></math>',
    '<math><mi onload="x">x</mi></math>', '<math><mi>'+ 'x'.repeat(2 * 1024 * 1024) + '</mi></math>']) assert.equal(safeMathml(value), false);
});
test('Word conversion deduplicates candidates, probes the actual writer and keeps unsupported image bytes', async () => {
  const first = wrapper(simple), repeated = wrapper(simple), fallback = wrapper(null), ast = document(first, repeated, fallback), original = structuredClone(fallback.c[1]);
  const calls = [];
  const statistics = await prepareWordMath(ast, async (args, input) => { calls.push({ args, input }); return args.includes('--to=json') ? result(mathNode) : Buffer.from(''); }, '/temporary');
  assert.deepEqual(statistics, { editable: 2, fallback: 1 }); assert.equal(calls.length, 2);
  assert.equal((calls[0].input.match(/<math /g) || []).length, 1); assert.ok(calls[1].args.includes('--fail-if-warnings'));
  assert.deepEqual(first, mathNode); assert.deepEqual(repeated, mathNode); assert.deepEqual(fallback.c[1], original); assert.deepEqual(fallback.c[0][2], []);
});
test('failed MathML parsing or Word writing preserves every fallback rather than plain TeX', async () => {
  for (const failAt of ['parse', 'write']) {
    const formula = wrapper(simple), original = structuredClone(formula.c[1]);
    const stats = await prepareWordMath(document(formula), async args => {
      if (failAt === 'parse' || args.includes('--to=docx')) throw new Error('conversion warning');
      return result(mathNode);
    }, '/temporary');
    assert.deepEqual(stats, { editable: 0, fallback: 1 }); assert.deepEqual(formula.c[1], original);
  }
});
test('non-math parser output and invalid exchange payloads cannot replace fallback images', async () => {
  const formula = wrapper(simple), invalid = wrapper('<math><img src="file:///secret"/></math>');
  const stats = await prepareWordMath(document(formula, invalid), async () => result({ t: 'Str', c: 'not math' }), '/temporary');
  assert.deepEqual(stats, { editable: 0, fallback: 2 }); assert.equal(formula.c[1][0].t, 'Image'); assert.equal(invalid.c[1][0].t, 'Image');
});

const test = require('node:test');
const assert = require('node:assert/strict');

async function api() { return import('../src/markdown-render.ts'); }
function semantic(node) { const { position, data, ...value } = node; if (value.children) value.children = value.children.map(semantic); return value; }
function all(tree, type) { const result = []; (function walk(node) { if (node.type === type) result.push(node); node.children?.forEach(walk); })(tree); return result; }

test('extended Markdown reparses with the same structure after serialization', async () => {
  const { parseMarkdown, markdownProcessor } = await api();
  const source = '[TOC]\n\n# Heading\n\n> [!NOTE]\n> Alert **body**.\n>\n> - item\n\nH~2~O x^2^ ==highlight *emphasis* and `code`== :smile: ~~deleted~~\n\nA footnote[^abc].\n\n[^abc]: A **note**.\n';
  const tree = parseMarkdown(source), serialized = markdownProcessor().stringify(tree);
  assert.deepEqual(semantic(parseMarkdown(serialized)), semantic(tree));
  for (const syntax of ['[TOC]', '> [!NOTE]', 'H~2~O', 'x^2^', ':smile:', '[^abc]']) assert.ok(serialized.includes(syntax), syntax);
});

test('code, math, escaped markers and entity literals do not become extensions', async () => {
  const { parseMarkdown, markdownProcessor } = await api();
  const source = '\\[TOC]\n\n&#91;TOC]\n\n> \\[!NOTE]\n> literal\n\n`H~2~O ^x^ ==h== :smile:` $x^2 + H~2~O + :smile:$\n\n\\~literal\\~ \\^literal\\^ \\==literal== \\:smile:\n\n```md\n[TOC]\nH~2~O\n> [!NOTE]\n```\n';
  const tree = parseMarkdown(source);
  for (const type of ['moyeToc', 'moyeAlert', 'moyeSub', 'moyeSup', 'moyeHighlight', 'moyeEmoji']) assert.equal(all(tree, type).length, 0, type);
  assert.deepEqual(semantic(parseMarkdown(markdownProcessor().stringify(tree))), semantic(tree));
});

test('single tilde subscript is distinct from strikethrough and nested spans remain structured', async () => {
  const { parseMarkdown, renderMarkdown } = await api();
  const source = 'H~2~O ~~gone~~ x^2^ ==**bold** and ~sub~ and `==code==`== :unknown_emoji: :rocket:';
  const tree = parseMarkdown(source);
  assert.equal(all(tree, 'moyeSub').length, 2); assert.equal(all(tree, 'delete').length, 1);
  const { html } = renderMarkdown(source);
  assert.match(html, /<mark><strong>bold<\/strong> and <sub>sub<\/sub> and <code>==code==<\/code><\/mark>/);
  assert.match(html, /:unknown_emoji:/); assert.match(html, /🚀/);
});

test('HTML export semantics include unique TOC anchors, alert body and linked footnotes', async () => {
  const { renderMarkdown } = await api();
  const { html } = renderMarkdown('[TOC]\n\n# 标题\n\n## 标题\n\n## 标题-1\n\n# 标题\n\n> [!WARNING]\n> Keep **this**.\n\nTwo refs[^a] and [^a].\n\n[^a]: Footnote.');
  for (const id of ['标题', '标题-1', '标题-1-1', '标题-2']) { assert.ok(html.includes(`id="${id}"`)); assert.ok(html.includes(`href="#${id}"`)); }
  assert.match(html, /data-kind="warning"/); assert.match(html, /Keep <strong>this<\/strong>/);
  assert.match(html, /id="moye-fn-a"/); assert.match(html, /href="#moye-fnref-a-2"/);
});

test('raw HTML is retained verbatim as source and cannot become executable export markup', async () => {
  const { parseMarkdown, markdownProcessor, renderMarkdown } = await api();
  const raw = '<script>globalThis.pwned = true</script>\n\n<div onclick="alert(1)">raw & <b>content</b></div>\n\nInline <img src=x onerror=alert(2)> end.\n';
  const tree = parseMarkdown(raw), { html } = renderMarkdown(raw);
  assert.equal(all(tree, 'moyeRaw').length, 2);
  const serialized = markdownProcessor().stringify(tree);
  assert.ok(serialized.includes('<script>globalThis.pwned = true</script>'));
  assert.ok(serialized.includes('<div onclick="alert(1)">raw & <b>content</b></div>'));
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.match(html, /&#x3C;script>/);
});

test('math slots preserve document order and TeX; YAML never enters rendering', async () => {
  const { renderMarkdown } = await api();
  const result = renderMarkdown('\uFEFF---\r\ntitle: hidden\r\n---\r\n\r\n$z$ $$z$$\n\n$$\n\\begin{equation}x\\label{x}\\end{equation}\n$$\n\n```latex\n\\ce{H2O}\n```');
  assert.deepEqual(result.expressions.map(item => item.display), [false, false, true, true]);
  assert.equal(result.expressions[0].tex, result.expressions[1].tex); assert.ok(!result.html.includes('title: hidden'));
  assert.equal((result.html.match(/data-moye-math=/g) || []).length, 4);
});

test('CRLF alerts have the same structure as LF alerts', async () => {
  const { parseMarkdown } = await api();
  const source = '> [!TIP]\n> A note.\n\n';
  assert.deepEqual(semantic(parseMarkdown(source.replaceAll('\n', '\r\n'))), semantic(parseMarkdown(source)));
  assert.equal(all(parseMarkdown(source.replaceAll('\n', '\r\n')), 'moyeAlert').length, 1);
});

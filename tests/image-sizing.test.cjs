const test = require('node:test');
const assert = require('node:assert/strict');

test('only standalone safe image tags become image nodes; code, inline HTML and unknown attributes stay source', async () => {
  const { parseMarkdown, renderMarkdown, markdownProcessor } = await import('../src/markdown-render.ts');
  const source = '\uFEFF---\r\ntitle: original\r\n---\r\n\r\n<img src="local.png" alt="A &amp; B" title="title" width="240">\r\n\r\n![Normal alt](normal.png "normal title")\r\n\r\n```html\n<img src="code.png" width="20">\n```\n\nText <img src="inline.png" width="30"> continues.\n\n<img src="unknown.png" width="40" onload="evil()">\n';
  const tree = parseMarkdown(source);
  assert.equal(tree.children.filter(node => node.type === 'mekiImage').length, 1);
  assert.equal(tree.children.filter(node => node.type === 'mekiRaw').length, 1);
  const html = renderMarkdown(source).html;
  assert.match(html, /<img src="local.png" alt="A &#x26; B" title="title" width="240" style="width:240px;height:auto;">/);
  assert.match(html, /<img src="normal.png" alt="Normal alt" title="normal title">/);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.ok(html.includes('&#x3C;img src="unknown.png"')); assert.ok(!html.includes('<script'));
  const serialized = markdownProcessor().stringify(tree);
  assert.ok(serialized.includes('<img src="local.png" alt="A &amp; B" title="title" width="240">'));
  assert.ok(serialized.includes('![Normal alt](normal.png "normal title")'));
  assert.ok(serialized.includes('onload="evil()"'));
});

test('image dimensions remain semantic attributes for HTML and converters after CSS removal', async () => {
  const { renderMarkdown } = await import('../src/markdown-render.ts');
  const html = renderMarkdown('<img src="one.png" alt="Portrait" width="240" height="400">\n\n<img src="two.png" height="80">').html;
  assert.match(html, /width="240" height="400"/);
  assert.match(html, /aspect-ratio:240\/400/);
  assert.match(html, /src="two.png" alt="" height="80"/);
  assert.match(html, /height:80px;width:auto/);
  assert.ok(!html.includes('data-'));
});

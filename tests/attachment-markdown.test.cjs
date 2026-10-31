const test = require('node:test');
const assert = require('node:assert/strict');

test('attachment edits preserve original Markdown, YAML, code, alt, titles and line endings', async () => {
  const { scanAttachmentImages, attachmentEdits, applyMarkdownEdits } = await import('../src/attachment-markdown.ts');
  const source = '\uFEFF---\r\ncover: "![yaml](old.png)"\r\n---\r\n# 原文\r\n\r\n![A \\[x\\] & **bold**](<图 片.png?size=1#frag> \'原 title\')\r\n\r\n![nested [text]](folder/a\\(1\\).png "keep")\r\n\r\n`![inline](old.png)`\r\n\r\n```md\r\n![fenced](old.png)\r\n```\r\n\r\n    ![indent](old.png)\r\n\r\n<div><img src="old.png"></div>\r\n\r\n<img src="old.png" onerror="bad()">\r\n';
  const images = scanAttachmentImages(source);
  assert.equal(images.length, 2); assert.equal(images[0].source, '图 片.png?size=1#frag'); assert.equal(images[1].source, 'folder/a(1).png');
  const edits = attachmentEdits(source, images, [{ source: images[0].source, relativePath: 'doc.assets/1.png?size=1#frag' }, { source: images[1].source, relativePath: 'doc.assets/2.png' }]);
  assert.equal(applyMarkdownEdits(source, edits), source.replace('图 片.png?size=1#frag', 'doc.assets/1.png?size=1#frag').replace('folder/a\\(1\\).png', 'doc.assets/2.png'));
});

test('reference images update only the image occurrence, not a shared definition or normal link', async () => {
  const { scanAttachmentImages, attachmentEdits, applyMarkdownEdits } = await import('../src/attachment-markdown.ts');
  const source = '![escaped \\] alt][Ref]\n\n![ref][] and ![REF]\n\n[ordinary][ref]\n\n[ref]: <images/a.png> "A \\"quoted\\" title"\n';
  const images = scanAttachmentImages(source); assert.equal(images.length, 3);
  const after = applyMarkdownEdits(source, attachmentEdits(source, images, [{ source: 'images/a.png', relativePath: 'doc.assets/copied.png' }]));
  assert.ok(after.includes('[ordinary][ref]')); assert.ok(after.includes('[ref]: <images/a.png> "A \\"quoted\\" title"'));
  assert.ok(after.startsWith('![escaped \\] alt](doc.assets/copied.png "A \\"quoted\\" title")'));
  assert.deepEqual(scanAttachmentImages(after).map(image => image.source), ['doc.assets/copied.png', 'doc.assets/copied.png', 'doc.assets/copied.png']);
});

test('safe sized image HTML preserves every attribute and unsafe or compound HTML stays untouched', async () => {
  const { scanAttachmentImages, attachmentEdits, applyMarkdownEdits } = await import('../src/attachment-markdown.ts');
  const tag = `<img\n width='240' alt='A &amp; B' src='old.png?x=1&amp;y=2#frag' title="Original" height=160 />`;
  const source = `${tag}\n\n<p><img src="old.png"></p>\n\n<img src="old.png" style="width:10px">\n`;
  const images = scanAttachmentImages(source); assert.equal(images.length, 1); assert.equal(images[0].source, 'old.png?x=1&y=2#frag');
  const after = applyMarkdownEdits(source, attachmentEdits(source, images, [{ source: images[0].source, relativePath: 'doc.assets/new.png?x=1&y=2#frag' }]));
  assert.equal(after, source.replace('old.png?x=1&amp;y=2#frag', 'doc.assets/new.png?x=1&amp;y=2#frag'));
});

test('embedded and remote image destinations are parsed without touching math or escaped images', async () => {
  const { scanAttachmentImages, attachmentEdits, applyMarkdownEdits } = await import('../src/attachment-markdown.ts');
  const source = String.raw`\![literal](old.png)

$![math](old.png)$

![data](data:image/png;base64,aGVsbG8=)

![remote](https://example.com/a.png "remote")
`;
  const images = scanAttachmentImages(source); assert.equal(images.length, 2);
  const after = applyMarkdownEdits(source, attachmentEdits(source, images, [{ source: images[0].source, relativePath: 'doc.assets/image.png#x(y)' }]));
  assert.equal(after, source.replace('data:image/png;base64,aGVsbG8=', 'doc.assets/image.png#x%28y%29'));
  assert.throws(() => attachmentEdits(source.replace('aGVsbG8=', 'another='), images, [{ source: images[0].source, relativePath: 'x.png' }]), /变化/);
  assert.throws(() => applyMarkdownEdits(source, [{ from: 9, to: 10, insert: '' }, { from: 8, to: 12, insert: '' }]), /范围/);
});

test('concrete image tokens preserve brackets inside code, HTML, math, and nested links in descriptions', async () => {
  const { scanAttachmentImages, attachmentEdits, applyMarkdownEdits } = await import('../src/attachment-markdown.ts');
  const cases = [
    '![a `]` b](x.png)', '![a ``[ ]`` b](x.png)', '![a <span title="]"> b](x.png)',
    '![a $]$ b](x.png)', '![a [nested](link.md) b](x.png)', '![outer ![nested](nested.png)](x.png)',
    '![a](x((1)).png "keep")', '![a](<x space.png>\n "keep")',
  ];
  for (const source of cases) {
    const refs = scanAttachmentImages(source); assert.equal(refs.length, 1, source);
    const after = applyMarkdownEdits(source, attachmentEdits(source, refs, [{ source: refs[0].source, relativePath: 'doc.assets/new.png' }]));
    assert.equal(after, source.slice(0, refs[0].from) + 'doc.assets/new.png' + source.slice(refs[0].to));
    assert.equal(scanAttachmentImages(after)[0].source, 'doc.assets/new.png');
  }
  const reference = '![a `]` [nested](link.md) b][ref]\n\n[ref]: x.png "t"';
  assert.equal(applyMarkdownEdits(reference, attachmentEdits(reference, scanAttachmentImages(reference), [{ source: 'x.png', relativePath: 'doc.assets/new.png' }])), '![a `]` [nested](link.md) b](doc.assets/new.png "t")\n\n[ref]: x.png "t"');
  assert.deepEqual(scanAttachmentImages('![]()'), []);
});

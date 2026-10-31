const test = require('node:test');
const assert = require('node:assert/strict');

test('single image syntax decodes descriptions and records the exact source interval', async () => {
  const { parseImageTag, imageTag } = await import('../src/image-syntax.ts');
  const source = ` <IMG title="标题 &quot;A&quot;" src='图%20片.png?x=1&amp;y=2' width=320 height="200" alt="描述 &lt;保留&gt;" /> `;
  const image = parseImageTag(source);
  assert.ok(image); assert.equal(image.src, '图%20片.png?x=1&y=2'); assert.equal(image.alt, '描述 <保留>'); assert.equal(image.title, '标题 "A"');
  assert.equal(image.width, 320); assert.equal(image.height, 200); assert.equal(image.quote, "'");
  assert.equal(source.slice(image.srcStart, image.srcEnd), '图%20片.png?x=1&amp;y=2');
  const canonical = parseImageTag(imageTag(image));
  for (const key of ['src', 'alt', 'title', 'width', 'height']) assert.equal(canonical[key], image[key]);
  assert.equal(parseImageTag('<img src="x.png">').width, null);
});

test('unknown HTML, events, ambiguous attributes and dangerous image URLs stay unrecognized', async () => {
  const { parseImageTag } = await import('../src/image-syntax.ts');
  for (const source of [
    '<img src="x" onerror="alert(1)">', '<img src="x" style="width:40px">', '<img src="x" srcset="evil 2x">',
    '<img src="x" SRC="y">', '<img src=x width=10>', '<img src="x" width="100%">', '<img src="x" width="0">',
    '<img src="x" height="-10">', '<img src="x" width="10001">', '<img src="x" width="NaN">',
    '<img src="javascript:alert(1)">', '<img src="java&#x73;cript&#58;alert(1)">', '<img src="data:text/html;base64,PHNjcmlwdD4=">',
    '<img src="//example.com/x.png">', '<img src="java\nscript:evil">', '<img src="%6aavascript%3Aevil">',
    '<img src="x"> <script>evil()</script>', '<img src="x"><img src="y">', '<p><img src="x"></p>',
    '<!-- before --><img src="x">', '<img src="x" alt="&unknown;">', '<img src="x" alt="&#0;">',
    '<img src="x"', '<img src="x" width=10', 'prefix <img src="x">',
  ]) assert.equal(parseImageTag(source), null, source);
  assert.ok(parseImageTag('<img src="https://example.com/a.png?x=1&amp;y=2" width="120">'));
  assert.ok(parseImageTag('<img src="data:image/png;base64,aGVsbG8=" width="120">'));
  assert.ok(parseImageTag('<img src="file:///C:/Pictures/a.png" width="120">'));
});

test('image source relocation preserves dimensions, quote choice and every other source byte', async () => {
  const { rewriteImageSource, parseImageTag } = await import('../src/image-syntax.ts');
  const source = `<img\r\n  width='240' alt='A &amp; B' src='old.png' title="Original" height=160 />`;
  const changed = rewriteImageSource(source, "文稿.assets/new's&one.png");
  assert.equal(changed, source.replace('old.png', '文稿.assets/new&#39;s&amp;one.png'));
  assert.equal(parseImageTag(changed).src, "文稿.assets/new's&one.png");
  assert.equal(rewriteImageSource(source, 'javascript:alert(1)'), null);
  assert.equal(rewriteImageSource('<img src="x" onerror="bad()">', 'good.png'), null);
});

test('image dimensions are bounded and generated styles contain only validated numbers', async () => {
  const { imageDimension, imageSizeStyle } = await import('../src/image-syntax.ts');
  assert.equal(imageDimension(240), 240);
  for (const value of [0, -1, 0.5, 10001, NaN, Infinity, '240', null]) assert.equal(imageDimension(value), null);
  assert.equal(imageSizeStyle({ width: 240, height: null }), 'width:240px;height:auto;');
  assert.equal(imageSizeStyle({ width: 240, height: 160 }), 'width:240px;height:auto;aspect-ratio:240/160;');
  assert.equal(imageSizeStyle({ width: null, height: 160 }), 'height:160px;width:auto;');
});

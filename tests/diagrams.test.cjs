const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Mermaid Markdown slots preserve source and order, leaving other code and math intact', async () => {
  const { renderMarkdown } = await import('../src/markdown-render.ts');
  const sources = ['flowchart LR\n A[开始] --> B[完成]', 'sequenceDiagram\n甲->>乙:消息'];
  const rendered = renderMarkdown(`# 图表\n\n\`\`\`mermaid\n${sources[0]}\n\`\`\`\n\n> \`\`\`Mermaid\n> ${sources[1].replace(/\n/g, '\n> ')}\n> \`\`\`\n\n\`\`\`js\nconst mermaid = '<img>';\n\`\`\`\n\n$x=1$`);
  assert.deepEqual(rendered.diagrams, sources);
  assert.deepEqual(rendered.expressions, [{ tex: 'x=1', display: false }]);
  assert.match(rendered.html, /data-moye-diagram="0"/);
  assert.match(rendered.html, /data-moye-diagram="1"/);
  assert.match(rendered.html, /class="language-js"/);
  assert.ok(!rendered.html.includes('<img>'));
});

test('diagram policy accepts ordinary diagrams, Unicode and SVG label line breaks', async () => {
  const { validateDiagramSource, diagramTheme, diagramPalettes } = await import('../src/diagram-policy.ts');
  for (const source of ['flowchart LR\nA[开始<br/>下一步] --> B[完成]', 'classDiagram\nclass User {\n +String name\n}', 'mindmap\n root((项目))\n  设计\n  实现', 'xychart\nx-axis [一, 二]\nbar [1, 2]']) assert.equal(validateDiagramSource(source), undefined);
  assert.equal(diagramTheme('night'), 'night'); assert.equal(diagramTheme('arbitrary'), 'paper');
  assert.notEqual(diagramPalettes.night.foreground, diagramPalettes.paper.foreground);
});

test('diagram policy rejects per-document configuration, callbacks and resources before rendering', async () => {
  const { validateDiagramSource } = await import('../src/diagram-policy.ts');
  for (const source of ['%%{init:{"securityLevel":"loose"}}%%\nflowchart LR\nA-->B', '---\nconfig:\n theme: dark\n---\nflowchart LR\nA-->B', 'flowchart LR\nA-->B\nclick A "https://example.com"', 'flowchart LR\nA[<img src="https://example.com/a">]', 'flowchart LR\nA@{img: "https://example.com/a"}', 'flowchart LR\nA-->B\nstyle A fill:url(https://example.com/a)', 'flowchart LR\nA-->B\nstyle A fill:u\\72l(https://example.com/a)', 'flowchart LR\nA-->B\nstyle A fill:ur/**/l(https://example.com/a)', 'flowchart LR\nA[&#60;img src=x&#62;]']) assert.ok(validateDiagramSource(source), source);
  assert.ok(validateDiagramSource('x'.repeat(64_001)));
  assert.ok(validateDiagramSource(''));
});

test('SVG styles accept local marker references and reject network or script paints', async () => {
  const { safeDiagramStyleValue, escapeDiagramText } = await import('../src/diagram-policy.ts');
  for (const value of ['#ffaaaa', 'url(#arrow-1)', 'url("#gradient")', 'system-ui, sans-serif', '14px']) assert.ok(safeDiagramStyleValue(value), value);
  for (const value of ['url(https://example.com/a)', 'url(file:///etc/x)', 'u\\72 l(https://example.com/a)', 'image-set("https://example.com/a")', 'expression(alert(1))', '@import "x"']) assert.equal(safeDiagramStyleValue(value), false, value);
  assert.equal(escapeDiagramText('<img onerror="bad">'), '&lt;img onerror=&quot;bad&quot;&gt;');
});

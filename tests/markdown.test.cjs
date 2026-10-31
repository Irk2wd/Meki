const { test } = require('node:test');
const assert = require('node:assert/strict');
test('metadata preserves empty, populated, CRLF, BOM and dot terminator', async () => {
  const { separateMetadata } = await import('../src/markdown.ts');
  for (const prefix of ['---\n---\n', '---\ntitle: x\n---\n', '\uFEFF---\r\n\r\n...\r\n', '---\n---']) {
    const suffix = prefix.endsWith('\n') ? '\n# Body\n' : '';
    assert.deepEqual(separateMetadata(prefix + suffix), { prefix, body: suffix });
  }
});
test('non-frontmatter and unclosed separators remain in body', async () => {
  const { separateMetadata } = await import('../src/markdown.ts');
  for (const body of ['Text\n---\n---\n', '---\nno terminator', '# Title\n', '']) assert.deepEqual(separateMetadata(body), { prefix: '', body });
});

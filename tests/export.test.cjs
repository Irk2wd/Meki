const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateExport, validateRaster, validateDiagramSvg, pdfPrintOptions } = require('../electron/export-policy.cjs');
const { cleanAst, imageData, PandocService, supportedVersion } = require('../electron/pandoc-service.cjs');
const base = { kind: 'pdf', html: '<p>文稿</p>', suggestedName: '文稿' };

test('PDF settings validate units, paper, header margins and reject unknown fields', () => {
  const input = validateExport({ ...base, theme: 'linen', fontSize: 20, referenceId: null, pdf: { pageSize: 'Letter', landscape: true, margin: 25.4, pageNumbers: true, header: true, pageBreakBeforeH1: true } });
  const options = pdfPrintOptions(input.pdf, '<script>标题</script>');
  assert.equal(options.pageSize, 'Letter'); assert.equal(options.landscape, true); assert.equal(options.margins.top, 1);
  assert.equal(options.preferCSSPageSize, false); assert.match(options.headerTemplate, /&lt;script&gt;/); assert.match(options.footerTemplate, /totalPages/);
  assert.equal(input.pdf.pageBreakBeforeH1, true); assert.equal(input.theme, 'linen'); assert.equal(input.fontSize, 20); assert.equal(validateExport(base).pdf.pageBreakBeforeH1, false);
  for (const pdf of [[], { margin: 0 }, { margin: NaN }, { margin: 50 }, { pageSize: 'A0' }, { landscape: 'yes' }, { margin: 5, header: true }, { pageBreakBeforeH1: 'yes' }, { printBackground: false }, { toString: 'not a PDF option' }]) assert.throws(() => validateExport({ ...base, pdf }));
  for (const patch of [{ theme: 'unknown' }, { fontSize: 100 }, { fontSize: '20' }, { referenceId: '../private.docx' }, { referenceId: 123 }]) assert.throws(() => validateExport({ ...base, ...patch }));
  assert.throws(() => validateExport({ ...base, outputPath: '/private' }));
});
test('PDF headers follow document text color without accepting CSS or HTML injection', () => {
  const { pdf } = validateExport({ ...base, pdf: { header: true, pageNumbers: true } });
  for (const color of ['rgb(217, 223, 213)', 'rgba(40, 50, 60, 0.9)', 'color(display-p3 0.8 0.9 1)', '#fff']) {
    const options = pdfPrintOptions(pdf, '文稿', color);
    assert.ok(options.headerTemplate.includes(`color:${color}`)); assert.ok(options.footerTemplate.includes(`color:${color}`));
  }
  for (const color of [null, {}, 'red; background:url(https://example.com)', '\"><script>alert(1)</script>', 'x'.repeat(1024)]) {
    const options = pdfPrintOptions(pdf, '<unsafe>', color);
    assert.match(options.headerTemplate, /color:#555/); assert.match(options.headerTemplate, /&lt;unsafe&gt;/);
    assert.doesNotMatch(options.headerTemplate, /<script|url\(/);
  }
});

test('PNG limits account for physical pixel scale and reject unbounded screenshots', () => {
  validateRaster(960, 9000, 2); validateRaster(1600, 12000, 1);
  for (const dimensions of [[960, 10001, 2], [1600, 10000, 2], [0, 20, 1], [Infinity, 20, 1]]) assert.throws(() => validateRaster(...dimensions));
  for (const pngWidth of [639, 1601, 900.5, '900']) assert.throws(() => validateExport({ ...base, kind: 'png', pngWidth }));
  assert.throws(() => validateExport({ ...base, kind: 'png', pngScale: 4 }));
});
test('standalone SVG keeps internal markers but rejects active or external resources', () => {
  const valid = '<svg xmlns="http://www.w3.org/2000/svg"><style>.edge{marker-end:url(#arrow)}</style><path style="fill:url(\'\u0023gradient\')"/></svg>';
  assert.equal(validateDiagramSvg(valid), valid);
  for (const content of ['<script>alert(1)</script>', '<image href="file:///private"/>', '<use href="https://example.com/x"/>', '<rect onload="alert(1)"/>', '<!ENTITY x SYSTEM "file:///private">', '<style>.a{fill:url(https://example.com)}</style>', '<path style="fill:u&#114;l(https://example.com)"/>', '<style>.a{fill:u\\72l(https://example.com)}</style>', '<style>@import "https://example.com";</style>']) assert.throws(() => validateDiagramSvg(`<svg>${content}</svg>`));
});
test('Pandoc AST policy removes metadata options and raw execution while retaining math', async () => {
  for (const version of [undefined, '2.12', '3.1.9', '3.12', 'unknown']) assert.equal(supportedVersion(version), false);
  for (const version of ['3.12.1', '3.13', '4.0']) assert.equal(supportedVersion(version), true);
  const ast = { 'pandoc-api-version': [1,23,1], meta: { filters: { t: 'MetaString', c: 'danger.lua' } }, blocks: [{ t: 'RawBlock', c: ['html', '<script>alert(1)</script>'] }, { t: 'Para', c: [{ t: 'Math', c: [{ t: 'InlineMath' }, 'E=mc^2'] }, { t: 'Image', c: [['', [], []], [{ t: 'Str', c: 'private' }], ['file:///private.txt', '']] }, { t: 'Link', c: [['', [], []], [{ t: 'Str', c: 'link' }], ['javascript:alert(1)', '']] }] }] };
  const safe = await cleanAst(ast, async () => null);
  assert.deepEqual(safe.ast.meta, {}); assert.equal(safe.ast.blocks[0].t, 'CodeBlock');
  assert.equal(safe.ast.blocks[1].c[0].t, 'Math'); assert.equal(safe.ast.blocks[1].c[0].c[1], 'E=mc^2');
  assert.equal(safe.ast.blocks[1].c[1].t, 'Span'); assert.equal(safe.ast.blocks[1].c[2].t, 'Span'); assert.equal(safe.warnings.length, 1);
  assert.equal(imageData('data:image/svg+xml;base64,PHN2Zz4='), false); assert.equal(imageData('file:///private.png'), false);
});
test('conversion temporary folders are removed after an error', async () => {
  const service = new PandocService(os.tmpdir()); service.status = async () => ({ available: true, path: process.execPath });
  let folder;
  await assert.rejects(service.temporary(async temporary => { folder = temporary; await fs.writeFile(path.join(temporary, 'secret-snapshot'), 'test'); throw new Error('intentional failure'); }), /intentional/);
  assert.equal(await fs.stat(folder).catch(() => null), null);
});

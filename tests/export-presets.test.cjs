'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { deflateRawSync, crc32 } = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { FileStore } = require('../electron/file-store.cjs');
const { ExportPresets, validatePresetOptions, LIMITS } = require('../electron/export-presets.cjs');
const { validateDocx, zipEntries } = require('../electron/docx-template.cjs');
const { PandocService } = require('../electron/pandoc-service.cjs');
const parent = path.join(__dirname, '..', 'test-results');
const tinyParts = () => new Map([
  ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
  ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Template content must not be exported</w:t></w:r></w:p></w:body></w:document>'],
  ['word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'],
]);
function zip(parts, { method = 8, descriptor = false } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of parts) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), payload = method ? deflateRawSync(bytes) : bytes, encoded = Buffer.from(name), checksum = crc32(bytes), flags = 0x800 | (descriptor ? 8 : 0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(encoded.length, 26);
    if (!descriptor) { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(bytes.length, 22); }
    const footer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) { footer.writeUInt32LE(0x08074b50); footer.writeUInt32LE(checksum, 4); footer.writeUInt32LE(payload.length, 8); footer.writeUInt32LE(bytes.length, 12); }
    locals.push(local, encoded, payload, footer);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, encoded); offset += local.length + encoded.length + payload.length + footer.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.size ?? parts.length, 8); end.writeUInt16LE(parts.size ?? parts.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true }); const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'presets-')));
  t.after(async () => { assert.equal(path.dirname(root).toLowerCase(), (await fs.realpath(parent)).toLowerCase()); assert.ok(path.basename(root).startsWith('presets-')); await fs.rm(root, { recursive: true, force: true }); });
  const store = new FileStore(path.join(root, 'profile')); await store.init(); const presets = new ExportPresets(store); await presets.init();
  const file = path.join(root, '样式.docx'); await fs.writeFile(file, zip(tinyParts()));
  return { root, file, store, presets };
}
const basic = name => ({ name, options: { kind: 'pdf', pdf: { pageSize: 'Letter', landscape: true, margin: 18, pageNumbers: true, pageBreakBeforeH1: true }, theme: 'linen', fontSize: 20 } });
test('preset policy accepts bounded export choices and rejects paths, commands and malformed options', () => {
  const options = validatePresetOptions(basic('a').options); assert.equal(options.pdf.pageBreakBeforeH1, true); assert.equal(options.pngWidth, 960); assert.equal(options.referenceId, null);
  for (const input of [null, [], { kind: 'exe' }, { kind: 'pdf', outputPath: 'C:/secret' }, { kind: 'pdf', customCss: 'body{}' }, { kind: 'pdf', fontSize: NaN }, { kind: 'pdf', fontSize: 40 }, { kind: 'pdf', theme: 'javascript' }, { kind: 'pdf', referenceId: '../outside' }, { kind: 'pdf', pdf: { pageBreakBeforeH1: 'yes' } }, { kind: 'pdf', pdf: { margin: 5, header: true } }, { kind: 'png', pngWidth: 2000 }]) assert.throws(() => validatePresetOptions(input));
});
test('named presets retain all choices after reload; updates, deletion and returned copies are isolated', async t => {
  const { presets, store } = await fixture(t), saved = await presets.save(basic('报告'));
  saved.options.pdf.margin = 40; const reopened = new ExportPresets(store); await reopened.init();
  assert.equal((await reopened.list()).presets[0].options.pdf.margin, 18);
  await reopened.save({ ...basic('报告新版'), id: saved.id }); assert.equal((await presets.list()).presets[0].name, '报告新版');
  assert.equal(await presets.delete(saved.id), true); assert.equal(await presets.delete(saved.id), false); assert.equal((await reopened.list()).presets.length, 0);
  await assert.rejects(presets.save({ ...basic('deleted'), id: saved.id }), /删除/);
});
test('shared FileStore locking preserves concurrent changes from distinct window-facing service instances', async t => {
  const { presets, store } = await fixture(t), other = new ExportPresets(store); await other.init();
  const [a, b] = await Promise.all([presets.save(basic('one')), other.save(basic('two'))]);
  assert.deepEqual(new Set((await presets.list()).presets.map(item => item.id)), new Set([a.id, b.id]));
  await Promise.all([presets.delete(a.id), other.save({ ...basic('changed'), id: b.id })]); assert.equal((await presets.list()).presets[0].name, 'changed');
});
test('template import copies verified bytes, deduplicates them, and survives source removal', async t => {
  const { presets, file } = await fixture(t), original = await fs.readFile(file), imported = await presets.importReference(file);
  assert.equal((await presets.importReference(file)).id, imported.id); assert.deepEqual(await presets.readReference(imported.id), original);
  await fs.unlink(file); assert.deepEqual(await presets.readReference(imported.id), original);
  const saved = await presets.save({ name: 'Word', options: { kind: 'docx', referenceId: imported.id } });
  await assert.rejects(presets.deleteReference(imported.id), /使用/); await presets.delete(saved.id);
  assert.equal(await presets.deleteReference(imported.id), true); await assert.rejects(presets.readReference(imported.id), /不存在/);
});
test('failed index commit retains presets and removes only the newly imported template', async t => {
  const { presets, file } = await fixture(t); await presets.save(basic('keep')); const before = await fs.readFile(presets.indexPath), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === presets.indexPath) throw new Error('simulated index failure'); return rename(from, to); };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(presets.save(basic('not committed')), /simulated/); await assert.rejects(presets.importReference(file), /simulated/);
  assert.deepEqual(await fs.readFile(presets.indexPath), before); assert.deepEqual(await fs.readdir(presets.templatesRoot), []);
});
test('presets enforce name uniqueness, count limits, template ownership and invalid ID rejection', async t => {
  const { presets } = await fixture(t); await presets.save(basic('Report')); await assert.rejects(presets.save(basic('ＲＥＰＯＲＴ')), /重复/);
  for (let i = 1; i < LIMITS.presets; i++) await presets.save(basic(`Preset ${i}`)); await assert.rejects(presets.save(basic('overflow')), /20/);
  for (const name of ['', 'a\nb', 'a'.repeat(61)]) await assert.rejects(presets.save(basic(name)));
  await assert.rejects(presets.delete('../index')); await assert.rejects(presets.readReference('../external'));
  await assert.rejects(presets.save({ ...basic('unknown template'), id: (await presets.list()).presets[0].id, options: { kind: 'docx', referenceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }), /不存在/);
});
test('malformed indexes and linked storage paths are preserved and rejected', async t => {
  const { presets, root } = await fixture(t); await fs.writeFile(presets.indexPath, '{invalid');
  await assert.rejects(presets.save(basic('new')), /原数据已保留/); assert.equal(await fs.readFile(presets.indexPath, 'utf8'), '{invalid');
  await fs.unlink(presets.indexPath); const external = path.join(root, 'external.json'); await fs.writeFile(external, '{}'); await fs.link(external, presets.indexPath);
  await assert.rejects(presets.list(), /链接/); assert.equal(await fs.readFile(external, 'utf8'), '{}');
  await fs.unlink(presets.indexPath); await fs.rmdir(presets.templatesRoot); const redirected = path.join(root, 'redirected'); await fs.mkdir(redirected); await fs.symlink(redirected, presets.templatesRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(presets.list(), /链接/);
});
test('template source links, stored tampering, hard links and ZIP traversal cannot be consumed', async t => {
  const { presets, root, file } = await fixture(t), link = path.join(root, 'linked.docx'); await fs.link(file, link); await assert.rejects(presets.importReference(link), /链接/); await fs.unlink(link);
  const template = await presets.importReference(file), stored = path.join(presets.templatesRoot, `${template.id}.docx`); await fs.writeFile(stored, Buffer.from('tampered'));
  await assert.rejects(presets.readReference(template.id), /损坏/);
  for (const name of ['../evil.xml', '/root.xml', 'word/../../evil.xml', 'word\\evil.xml', 'word/evil%2exml']) { const parts = tinyParts(); parts.set(name, '<x/>'); assert.throws(() => validateDocx(zip(parts)), /文件名/); }
});
test('ZIP reader validates checksums, local headers, compression bounds, descriptors and unique records', () => {
  assert.equal(validateDocx(zip(tinyParts(), { method: 0 })).entries, 4); assert.equal(validateDocx(zip(tinyParts(), { descriptor: true })).entries, 4);
  const corrupt = zip(tinyParts(), { method: 0 }); corrupt[60] ^= 0xff; assert.throws(() => validateDocx(corrupt));
  const duplicate = [...tinyParts(), ['WORD/STYLES.XML', '<x/>']]; assert.throws(() => validateDocx(zip(duplicate)), /重复/);
  const encrypted = zip(tinyParts()); encrypted.writeUInt16LE(0x801, encrypted.readUInt32LE(encrypted.length - 6) + 8); assert.throws(() => validateDocx(encrypted));
  const oversized = zip(tinyParts()); oversized.writeUInt32LE(0x7fffffff, oversized.readUInt32LE(oversized.length - 6) + 24); assert.throws(() => validateDocx(oversized), /过大/);
  const symlink = zip(tinyParts()); symlink.writeUInt32LE(0xa1ff0000, symlink.readUInt32LE(symlink.length - 6) + 38); assert.throws(() => validateDocx(symlink), /链接/);
  assert.throws(() => validateDocx(Buffer.from('not a zip'))); assert.throws(() => validateDocx(zip(new Map([['word/document.xml', '<x/>']]))), /缺少/);
});
test('DOCX policy rejects macros, external resources, XML entities and active content but allows passive web links', () => {
  const blocked = [
    ['word/vbaProject.bin', 'macro'], ['word/embeddings/oleObject1.bin', 'object'], ['word/document.xml', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///private">]><w:document/>'],
    ['word/document.xml', '<w:document><w:instrText>DDEAUTO cmd</w:instrText></w:document>'],
    ['word/_rels/document.xml.rels', '<Relationships><Relationship Id="a" Type="hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<Relationships><Relationship Id="a" Type="image" Target="&#x68;ttps://example.com"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<Relationships><Relationship Id="a" Type="image" Target="../../outside.png"/></Relationships>'],
  ];
  const relationship = (type, target) => `<Relationships><Relationship Id="a" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/></Relationships>`;
  for (const [type, target] of [['image', 'https://example.com/photo.png'], ['hyperlink', 'https://user:password@example.com/'], ['hyperlink', 'file:///private.txt'], ['hyperlink', 'javascript:alert(1)'], ['attachedTemplate', 'https://example.com/template.docx']]) blocked.push(['word/_rels/document.xml.rels', relationship(type, target)]);
  for (const [name, content] of blocked) { const parts = tinyParts(); parts.set(name, content); assert.throws(() => validateDocx(zip(parts)), undefined, name); }
  for (const target of ['https://example.com/page', 'http://example.com/', 'mailto:hello@example.com']) { const parts = tinyParts(); parts.set('word/_rels/document.xml.rels', relationship('hyperlink', target)); assert.equal(validateDocx(zip(parts)).entries, 5); }
});
test('real Pandoc reference template imports safely and carries styles rather than template body into DOCX', async t => {
  const executable = process.env.MOYE_PANDOC_PATH;
  if (!executable) return t.skip('Set MOYE_PANDOC_PATH for the real converter integration.');
  const { presets, root } = await fixture(t), run = promisify(execFile), reference = path.join(root, 'reference.docx'), referenceInput = path.join(root, 'reference.md');
  await fs.writeFile(referenceInput, '# Sample template\n\nTemplate body must not appear in export.\n');
  await run(executable, ['--sandbox', '--from=markdown', '--to=docx', `--output=${reference}`, referenceInput], { windowsHide: true, timeout: 45000 });
  const parts = zipEntries(await fs.readFile(reference));
  parts.set('word/styles.xml', Buffer.from(parts.get('word/styles.xml').toString().replace(/<w:styles\b/, '<w:styles data-moye-test="reference-style-proof"')));
  await fs.writeFile(reference, zip(parts)); validateDocx(await fs.readFile(reference));
  const imported = await presets.importReference(reference), copied = path.join(root, 'approved.docx'); await fs.writeFile(copied, await presets.readReference(imported.id));
  const output = path.join(root, 'output.docx'), service = new PandocService(path.join(root, 'profile'));
  await fs.writeFile(output, await service.exportDocument('<h1>Exported heading</h1><p>Exported body.</p>', 'docx', 'Styled output', await fs.readFile(copied)));
  const generated = zipEntries(await fs.readFile(output)); assert.match(generated.get('word/styles.xml').toString(), /reference-style-proof/); assert.match(generated.get('word/document.xml').toString(), /Exported body/); assert.doesNotMatch(generated.get('word/document.xml').toString(), /Template body/);
});
test('the official Pandoc default reference.docx imports and exports with its passive example hyperlinks', async t => {
  const executable = process.env.MOYE_PANDOC_PATH;
  if (!executable) return t.skip('Set MOYE_PANDOC_PATH for the real converter integration.');
  const { presets, root } = await fixture(t), run = promisify(execFile), reference = path.join(root, 'default-reference.docx');
  await run(executable, [`--output=${reference}`, '--print-default-data-file=reference.docx'], { windowsHide: true, timeout: 45000 });
  const original = await fs.readFile(reference); assert.ok(validateDocx(original).entries > 4); const imported = await presets.importReference(reference);
  const selected = path.join(root, 'approved.docx'); await fs.writeFile(selected, await presets.readReference(imported.id));
  const output = path.join(root, 'output.docx'), service = new PandocService(path.join(root, 'profile'));
  await fs.writeFile(output, await service.exportDocument('<p>Only current body.</p>', 'docx', 'Default reference', await fs.readFile(selected)));
  const generated = zipEntries(await fs.readFile(output)); assert.match(generated.get('word/document.xml').toString(), /Only current body/); assert.doesNotMatch(generated.get('word/document.xml').toString(), /example.com/);
});

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, decodeDocument, digest, isWithin, pathKey, readBytes, validateAbsolutePath } = require('./file-store.cjs');
const { assert, validateEvidencePath } = require('./research-model.cjs');

const images = new Map(Object.entries({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
}));
const textFiles = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.log', '.tex', '.bib', '.xml', '.yaml', '.yml']);
const knownEvidence = new Set([...images.keys(), ...textFiles, '.pdf', '.exr', '.tiff', '.xlsx', '.docx', '.zip', '.rdc', '.nsight-gfx']);
const previewLimit = 24 * 1024 * 1024;

function bindingPath(root) {
  const local = process.env.MEKIR_LOCAL_STATE || path.join(os.homedir(), '.mekir');
  return path.join(local, 'sources', `${digest(Buffer.from(pathKey(root)))}.json`);
}

async function readBindings(root) {
  try {
    const { bytes } = await readBytes(bindingPath(root), 128 * 1024);
    return new Map(Object.entries(JSON.parse(decodeDocument(bytes).content)));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

async function bindDirectory(root, id, directory) {
  const actual = await fs.realpath(validateAbsolutePath(directory));
  assert((await fs.stat(actual)).isDirectory(), 'Choose an evidence source directory.');
  const file = bindingPath(root);
  const bindings = await readBindings(root);
  bindings.set(id, actual);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, Buffer.from(JSON.stringify(Object.fromEntries(bindings), null, 2) + '\n'), { mode: 0o600 });
  return actual;
}

async function reachable(directory) {
  if (!directory) return false;
  try {
    const actual = await fs.realpath(directory);
    return pathKey(actual) === pathKey(directory) && (await fs.stat(actual)).isDirectory();
  } catch { return false; }
}

async function boundSources(root, sources = []) {
  if (!sources.length) return [];
  const bindings = await readBindings(root);
  return Promise.all(sources.map(async source => {
    const directory = bindings.get(source.id);
    return { ...source, directory, available: await reachable(directory) };
  }));
}

async function sourceDirectory(root, sourceId) {
  const directory = (await readBindings(root)).get(sourceId);
  assert(await reachable(directory), `Source ${sourceId} is unavailable. Bind its directory on this computer.`);
  return directory;
}

async function evidencePath(directory, relativePath) {
  validateEvidencePath(relativePath);
  const actual = await fs.realpath(path.join(directory, relativePath));
  assert(isWithin(actual, directory), 'The evidence file is outside its source directory.');
  const stat = await fs.stat(actual);
  assert(stat.isFile(), 'The evidence path must point to a file.');
  return { path: actual, size: stat.size };
}

async function previewEvidence(file, reference, source) {
  const result = { ...reference, source: source.label, kind: 'file' };
  const ext = path.extname(file.path).toLowerCase();
  const mime = images.get(ext);
  if (file.size > previewLimit || (!mime && !textFiles.has(ext))) return result;
  const { bytes } = await readBytes(file.path, previewLimit);
  if (mime) return { ...result, kind: 'image', mime, content: bytes.toString('base64') };
  return { ...result, kind: 'text', content: decodeDocument(bytes).content };
}

module.exports = { bindDirectory, boundSources, sourceDirectory, evidencePath, previewEvidence, knownEvidence };

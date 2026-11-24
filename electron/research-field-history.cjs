'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { atomicWrite, digest, readBytes, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');
const { assert, validateField } = require('./research-model.cjs');

// A record points to immutable definitions. An interrupted write can leave an unused
// snapshot, but can never change the interpretation of a previously saved record.
function captureFieldRules(record, previous, type, suppliedFields) {
  const old = previous?.record;
  if (old?.type === record.type && isDeepStrictEqual(old.fields, record.fields)) {
    if (old.fieldRules) record.fieldRules = old.fieldRules;
    else delete record.fieldRules;
    return;
  }
  delete record.fieldRules;
  const fields = Object.create(null);
  const definitions = new Map((type?.fields || []).map(rule => [rule.id, rule]));
  for (const key of Object.keys(record.fields).sort()) {
    const value = record.fields[key];
    if (old?.type === record.type && Object.hasOwn(old.fields, key) && old.fields[key] === value) {
      const origin = previous.fieldOrigins?.[key];
      if (origin) fields[key] = { value, ...origin };
    } else if (definitions.has(key)) {
      fields[key] = { value, source: !old && !Object.hasOwn(suppliedFields || {}, key) ? 'default' : 'record', rule: definitions.get(key) };
    }
  }
  if (!Object.keys(fields).length) return;
  const bytes = Buffer.from(JSON.stringify({ version: 1, type: record.type, fields }) + '\n');
  assert(bytes.length <= MAX_DOCUMENT_BYTES, 'The field definitions exceed the record size limit.');
  record.fieldRules = digest(bytes);
  return bytes;
}

async function snapshotFile(store, reference, create) {
  const parent = store.indexPath ? path.dirname(store.manifestPath) : store.recordsPath;
  if (!await store.directory(parent)) return;
  const directory = path.join(parent, store.indexPath ? 'field-rules' : '.field-rules');
  if (await store.directory(directory, create)) return path.join(directory, reference + '.json');
}

async function loadSnapshot(store, reference) {
  try {
    const file = await snapshotFile(store, reference, false);
    if (!file) return;
    if (!(await fs.lstat(file)).isFile()) return;
    const { bytes } = await readBytes(file);
    if (digest(bytes) !== reference) return;
    const data = JSON.parse(bytes.toString('utf8'));
    if (data?.version !== 1 || typeof data.type !== 'string' || !data.fields || typeof data.fields !== 'object') return;
    for (const [id, item] of Object.entries(data.fields)) {
      if (!item || !['record', 'default'].includes(item.source) || item.rule?.id !== id) return;
      validateField(item.rule, data.type);
    }
    return data;
  } catch { /* An unavailable or invalid snapshot leaves the original Markdown readable. */ }
}

async function readFieldOrigins(store, record, cache) {
  const hash = record.fieldRules;
  if (!hash) return;
  let saved;
  if (cache?.has(hash)) saved = cache.get(hash);
  else {
    saved = await loadSnapshot(store, hash);
    cache?.set(hash, saved);
  }
  if (saved?.type !== record.type) return;
  const origins = Object.create(null);
  for (const [id, value] of Object.entries(record.fields)) {
    if (!Object.hasOwn(saved.fields, id)) continue;
    const { value: captured, source, rule } = saved.fields[id];
    if (value === captured) origins[id] = { source, rule };
  }
  return Object.keys(origins).length ? origins : undefined;
}

async function saveFieldRules(store, record, bytes) {
  if (!bytes) return;
  const file = await snapshotFile(store, record.fieldRules, true);
  assert(file, 'The field definitions folder is unavailable.');
  try {
    assert((await fs.lstat(file)).isFile(), 'Field definitions must be a regular project file.');
    if ((await readBytes(file)).bytes.equals(bytes)) return;
    throw new Error('A field definition snapshot has different contents at the same reference.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicWrite(file, bytes);
}

module.exports = { captureFieldRules, readFieldOrigins, saveFieldRules };

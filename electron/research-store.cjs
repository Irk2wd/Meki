'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite, readBytes, decodeDocument, digest, isDocumentPath, isWithin, pathKey, MAX_DOCUMENT_BYTES, RevisionConflictError } = require('./file-store.cjs');
const { WorkspaceStore } = require('./workspace-store.cjs');
const { bindDirectory, boundSources, sourceDirectory, evidencePath } = require('./research-evidence.cjs');
const { researchMatcher } = require('./research-filter.cjs');
const { planArchive, MAX_RUNS } = require('./research-import.cjs');
const {
  METADATA, MANIFEST, LEGACY_MANIFEST, INDEX, SUMMARIES, DOCUMENT_SCHEME, RECORDS, RECORD_FILE, REVISION,
  assert, object, array, id, validateProject, validateRecord,
  validateSource, validateEvidence, validateFilter,
  relationshipIssues, fieldIssues, validateChange, parseMarkdown, formatMarkdown, fileName, templateBody,
} = require('./research-model.cjs');

const MAX_JSON_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

async function statIfPresent(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function revisionConflict(label) {
  const error = new Error(`${label} changed. Read the latest revision and retry.`);
  error.code = 'RESEARCH_CONFLICT';
  return error;
}

function publicRecord(item) {
  const { record, revision, relativePath, body } = item;
  return { record, revision, relativePath, body };
}

function recordReference({ record, relativePath }) {
  return { id: record.id, title: record.title, date: record.date, relativePath };
}

function portablePath(file) {
  return file.split(path.sep).join('/');
}

function validateIndexPath(relativePath) {
  assert(typeof relativePath === 'string' && relativePath.length <= 4096 && isDocumentPath(relativePath)
    && !/[\\:\x00-\x1f]/.test(relativePath)
    && relativePath.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== METADATA),
  'Use a project-relative Markdown or text path with / separators.');
}

class ResearchStore {
  constructor(root, legacy = false) {
    this.root = root;
    this.manifestFile = legacy ? LEGACY_MANIFEST : MANIFEST;
    this.manifestPath = path.join(root, this.manifestFile);
    this.recordsPath = path.join(root, RECORDS);
    this.summaryPath = legacy ? null : path.join(root, SUMMARIES);
    this.indexPath = legacy ? null : path.join(root, INDEX);
    this.recordDirectories = this.summaryPath ? [this.recordsPath, this.summaryPath] : [this.recordsPath];
    this.sourceHref = legacy ? fileName : id => `${DOCUMENT_SCHEME}${id}`;
  }

  static async open(root) {
    root = await fs.realpath(root);
    for (const legacy of [false, true]) {
      const project = new ResearchStore(root, legacy);
      if (!legacy && !await project.directory(path.join(root, METADATA))) continue;
      const entry = await statIfPresent(project.manifestPath);
      if (!entry) continue;
      assert(entry.isFile(), `${project.manifestFile} must be a regular file in the project folder.`);
      return project;
    }
    return null;
  }

  static async forDocument(file) {
    if (!RECORD_FILE.test(path.basename(file))) return null;
    const directory = path.dirname(file);
    const parent = path.dirname(directory);
    const relative = portablePath(path.join(path.basename(parent), path.basename(directory)));
    const root = relative === SUMMARIES ? path.dirname(parent) : path.basename(directory) === RECORDS ? parent : null;
    if (!root) return null;
    const project = await ResearchStore.open(root);
    if (project) assert(pathKey(root) === pathKey(project.root), 'Open the project folder at its original location.');
    return project?.manages(file) ? project : null;
  }

  static async initialize(root, project, seed = []) {
    const validated = validateProject(project);
    const manifest = encodeJson(validated);
    const destination = path.join(await fs.realpath(path.dirname(root)), path.basename(root));
    const store = new ResearchStore(destination);
    const changes = store.prepareBatch(seed, validated, new Map(), new Map());
    await fs.mkdir(destination);
    await fs.mkdir(path.join(destination, METADATA));
    for (const directory of store.recordDirectories) await fs.mkdir(directory);
    for (const item of changes) await atomicWrite(path.join(destination, item.relativePath), item.bytes);
    await atomicWrite(store.indexPath, encodeJson({ version: 1, documents: {} }));
    await fs.writeFile(path.join(destination, 'AGENTS.md'), projectGuide, { flag: 'wx' });
    // The manifest makes the project visible to the app once its files are ready.
    await atomicWrite(store.manifestPath, manifest);
    return store;
  }

  async assertRoot() {
    assert(pathKey(await fs.realpath(this.root)) === pathKey(this.root), 'The project folder has moved. Open it again.');
  }

  async manifest() {
    await this.assertRoot();
    if (this.indexPath) await this.directory(path.dirname(this.manifestPath));
    const entry = await statIfPresent(this.manifestPath);
    assert(entry?.isFile(), `${this.manifestFile} must be a regular file in the project folder.`);
    const { bytes, mode } = await readBytes(this.manifestPath, MAX_JSON_BYTES);
    let project;
    try { project = JSON.parse(decodeDocument(bytes).content); }
    catch (error) { throw new Error(`Could not read ${this.manifestFile}: ${error.message}`); }
    return { project: validateProject(project), revision: digest(bytes), mode };
  }

  async directory(directory, create = false) {
    await this.assertRoot();
    if (directory === this.summaryPath && !await this.directory(path.dirname(directory))) return false;
    if (create) await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await statIfPresent(directory);
    if (!entry) return false;
    assert(entry.isDirectory() && pathKey(await fs.realpath(directory)) === pathKey(directory),
      `${portablePath(path.relative(this.root, directory))} must be a folder inside the project.`);
    return true;
  }

  manages(file) {
    return this.recordDirectories.some(directory => pathKey(file) === pathKey(directory) ||
      (pathKey(path.dirname(file)) === pathKey(directory) && RECORD_FILE.test(path.basename(file))));
  }

  async readFile(target, recordId) {
    const entry = await statIfPresent(target);
    assert(entry?.isFile(), `Record ${recordId} does not exist as a regular Markdown file.`);
    const { bytes, mode } = await readBytes(target);
    const { content, newline, bom } = decodeDocument(bytes);
    return {
      ...parseMarkdown(content, recordId), revision: digest(bytes), mode, newline, bom,
      relativePath: portablePath(path.relative(this.root, target)),
    };
  }

  async findRecord(recordId) {
    const name = fileName(recordId);
    let result;
    for (const directory of this.recordDirectories) {
      if (!await this.directory(directory)) continue;
      const candidate = path.join(directory, name);
      if (!await statIfPresent(candidate)) continue;
      assert(!result, `Multiple files use record ID ${recordId}.`);
      result = candidate;
    }
    return result;
  }

  async read(recordId) {
    const target = await this.findRecord(recordId);
    assert(target, `Record ${recordId} does not exist.`);
    return publicRecord(await this.readFile(target, recordId));
  }

  async catalog(bodyIds = new Set(), matches) {
    const items = new Map();
    const problems = [];
    const seen = new Set();
    const matchingIds = [];
    for (const directory of this.recordDirectories) {
      if (!await this.directory(directory)) continue;
      for (const file of (await fs.readdir(directory)).sort()) {
        const match = RECORD_FILE.exec(file);
        if (!match) continue;
        const recordId = match[1];
        const target = path.join(directory, file);
        try {
          if (seen.has(recordId)) {
            items.delete(recordId);
            throw new Error(`Multiple files use record ID ${recordId}.`);
          }
          seen.add(recordId);
          const item = await this.readFile(target, recordId);
          if (matches?.(item)) matchingIds.push(recordId);
          if (!bodyIds.has(recordId)) delete item.body;
          items.set(recordId, item);
        } catch (error) {
          problems.push({ file: portablePath(path.relative(this.root, target)), message: error.message });
        }
      }
    }
    return { items, problems, matchingIds };
  }

  async readIndex() {
    const paths = new Map();
    const evidence = new Map();
    if (!this.indexPath || !await this.directory(path.dirname(this.indexPath))) return { paths, evidence, revision: null };
    const entry = await statIfPresent(this.indexPath);
    if (!entry) return { paths, evidence, revision: null };
    assert(entry.isFile(), `${INDEX} must be a regular file in the project folder.`);
    const { bytes, mode } = await readBytes(this.indexPath, MAX_INDEX_BYTES);
    let index;
    try { index = JSON.parse(decodeDocument(bytes).content); }
    catch (error) { throw new Error(`Could not read ${INDEX}: ${error.message}`); }
    object(index, INDEX, ['version', 'documents', 'evidence']);
    assert(index.version === 1, `Unsupported version in ${INDEX}.`);
    object(index.documents, 'index.documents');
    for (const [documentId, relativePath] of Object.entries(index.documents)) {
      id(documentId, 'document ID');
      validateIndexPath(relativePath);
      paths.set(documentId, relativePath);
    }
    if (index.evidence !== undefined) {
      object(index.evidence, 'index.evidence');
      for (const [fileId, reference] of Object.entries(index.evidence)) {
        id(fileId, 'evidence ID');
        assert(!paths.has(fileId), `The document index already uses ID ${fileId}.`);
        evidence.set(fileId, validateEvidence(reference));
      }
    }
    return { paths, evidence, revision: digest(bytes), mode };
  }

  async indexedDocument(documentId, relativePath) {
    const target = path.join(this.root, relativePath);
    assert(!this.manages(target), `Record files already have a document ID: ${relativePath}.`);
    const file = await new WorkspaceStore(this.root).existing(target, { document: true });
    return { id: documentId, title: path.parse(file.path).name, relativePath };
  }

  async resolveDocument(documentId) {
    const target = await this.findRecord(documentId);
    if (target) return recordReference(await this.readFile(target, documentId));
    const { paths, evidence } = await this.readIndex();
    if (evidence.has(documentId)) return { id: documentId, ...evidence.get(documentId) };
    assert(paths.has(documentId), `Unknown document ID: ${documentId}.`);
    return this.indexedDocument(documentId, paths.get(documentId));
  }

  async writeIndex({ paths, evidence, revision, mode }) {
    const sorted = entries => Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b, 'en')));
    const bytes = encodeJson({ version: 1, documents: sorted(paths), ...(evidence.size ? { evidence: sorted(evidence) } : {}) }, MAX_INDEX_BYTES);
    await atomicWrite(this.indexPath, bytes, { mode, beforeCommit: async () => {
      if ((await this.readIndex()).revision !== revision) throw revisionConflict('The document index');
    } });
  }

  async indexDocument(documentId, relativePath) {
    id(documentId, 'document ID');
    validateIndexPath(relativePath);
    assert(this.indexPath, `Document indexing requires ${MANIFEST}.`);
    return this.locked(async () => {
      await this.manifest();
      assert(!await this.findRecord(documentId), `A research record already uses document ID ${documentId}.`);
      const document = await this.indexedDocument(documentId, relativePath);
      const index = await this.readIndex();
      assert(!index.evidence.has(documentId), `An evidence file already uses ID ${documentId}.`);
      if (index.paths.get(documentId) !== relativePath) {
        index.paths.set(documentId, relativePath);
        await this.writeIndex(index);
      }
      return document;
    });
  }

  async bindEvidenceSource(sourceId, directory, label) {
    assert(this.indexPath, `Evidence sources require ${MANIFEST}.`);
    id(sourceId, 'evidence source ID');
    return this.locked(async () => {
      const current = await this.manifest();
      const sources = current.project.evidenceSources || [];
      let source = sources.find(item => item.id === sourceId);
      if (!source) {
        source = validateSource({ id: sourceId, label });
        validateProject({ ...current.project, evidenceSources: [...sources, source] });
      }
      const absolute = await bindDirectory(this.root, sourceId, directory);
      if (!sources.includes(source)) await this.writeManifest({ ...current.project, evidenceSources: [...sources, source] }, current);
      return { ...source, directory: absolute, available: true };
    });
  }

  async indexEvidence(fileId, reference) {
    assert(this.indexPath, `Evidence indexing requires ${MANIFEST}.`);
    id(fileId, 'evidence ID');
    validateEvidence(reference);
    return this.locked(async () => {
      const { project } = await this.manifest();
      assert(project.evidenceSources?.some(item => item.id === reference.sourceId), `Unknown evidence source: ${reference.sourceId}.`);
      await evidencePath(await sourceDirectory(this.root, reference.sourceId), reference.relativePath);
      const index = await this.readIndex();
      assert(!index.paths.has(fileId) && !await this.findRecord(fileId), `A project document already uses ID ${fileId}.`);
      if (!isDeepStrictEqual(index.evidence.get(fileId), reference)) {
        index.evidence.set(fileId, reference);
        await this.writeIndex(index);
      }
      return { id: fileId, ...reference };
    });
  }

  async evidenceFile(fileId) {
    id(fileId, 'evidence ID');
    const { evidence } = await this.readIndex();
    const indexed = evidence.get(fileId);
    assert(indexed, `Unknown evidence ID: ${fileId}.`);
    const { project } = await this.manifest();
    const source = project.evidenceSources?.find(item => item.id === indexed.sourceId);
    assert(source, `Unknown evidence source: ${indexed.sourceId}.`);
    const directory = await sourceDirectory(this.root, source.id);
    return { source, reference: { id: fileId, ...indexed }, file: await evidencePath(directory, indexed.relativePath) };
  }

  async saveFilter(label, filter) {
    const saved = validateFilter({ ...validateFilter(filter), id: `filter-${digest(Buffer.from(String(label))).slice(0, 16)}`, label }, true);
    return this.locked(async () => {
      const current = await this.manifest();
      const filters = current.project.savedFilters || [];
      if (isDeepStrictEqual(filters.find(item => item.id === saved.id), saved)) return saved;
      const savedFilters = [...filters.filter(item => item.id !== saved.id), saved];
      await this.writeManifest(validateProject({ ...current.project, savedFilters }), current);
      return saved;
    });
  }

  async remapIndexedDocuments(previousPath, nextPath) {
    if (!this.indexPath) return;
    return this.locked(async () => {
      const index = await this.readIndex();
      let changed = false;
      for (const [documentId, relativePath] of index.paths) {
        const file = path.join(this.root, relativePath);
        if (!isWithin(file, previousPath)) continue;
        const target = portablePath(path.relative(this.root, path.join(nextPath, path.relative(previousPath, file))));
        validateIndexPath(target);
        index.paths.set(documentId, target);
        changed = true;
      }
      if (changed) await this.writeIndex(index);
    });
  }

  async documentIndex(items, index) {
    const documents = new Map([...items.values()].map(item => [item.record.id, recordReference(item)]));
    const problems = [];
    for (const [documentId, relativePath] of index.paths) {
      try {
        assert(!documents.has(documentId), `A research record already uses document ID ${documentId}.`);
        documents.set(documentId, await this.indexedDocument(documentId, relativePath));
      } catch (error) {
        problems.push({ file: relativePath, message: `${documentId}: ${error.message}` });
      }
    }
    for (const [fileId, reference] of index.evidence) {
      if (documents.has(fileId)) problems.push({ file: reference.relativePath, message: `A project document already uses ID ${fileId}.` });
      else documents.set(fileId, { id: fileId, ...reference });
    }
    return { documents, problems };
  }

  async snapshot(filter) {
    const { project, revision } = await this.manifest();
    const { items, problems, matchingIds } = await this.catalog(new Set(), filter && researchMatcher(validateFilter(filter), project));
    const index = await this.documentIndex(items, await this.readIndex());
    const records = [...items.values()].map(({ record, revision, relativePath }) => ({
      record, revision, relativePath,
      issues: [
        ...relationshipIssues(record, project),
        ...fieldIssues(record, project.recordTypes.find(type => type.id === record.type)).map(issue => issue.message),
        ...(record.sources || []).filter(source => !index.documents.has(source)).map(source => `Missing source document: ${source}.`),
        ...[...(record.evidence || []), ...(record.run?.evidence || [])].filter(file => !index.documents.get(file)?.sourceId).map(file => `Missing evidence: ${file}.`),
        ...(record.relations || []).filter(({ target }) => !index.documents.has(target)).map(({ target }) => `Missing relation target: ${target}.`),
      ],
    }));
    return {
      root: this.root, project, revision, manifestFile: this.manifestFile,
      records, documents: [...index.documents.values()], problems: [...problems, ...index.problems],
      ...(project.evidenceSources?.length ? { evidenceSources: await boundSources(this.root, project.evidenceSources) } : {}),
      ...(filter ? { matchingIds: matchingIds.filter(recordId => items.has(recordId)) } : {}),
    };
  }

  async linkedSummaries(targetId, project, filter) {
    const summaryTypes = new Set(project.recordTypes.filter(type => type.kind === 'summary').map(type => type.id));
    if (!summaryTypes.size || project.id === targetId) return [];
    const matchesFilter = filter && researchMatcher(validateFilter(filter), project);
    const matches = item => summaryTypes.has(item.record.type) && item.record.coverage &&
      item.record.relatedProjects?.includes(targetId) && (!matchesFilter || matchesFilter(item));
    const { items, matchingIds } = await this.catalog(new Set(), matches);
    return matchingIds.flatMap(recordId => {
      const item = items.get(recordId);
      return item ? [{ record: item.record, relativePath: item.relativePath }] : [];
    });
  }

  async locked(action) {
    await this.assertRoot();
    const lock = path.join(this.root, '.meki-research.lock');
    let handle;
    for (let attempt = 0; ; attempt++) {
      try { handle = await fs.open(lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt === 40) throw new Error('This project is being written by another process. Retry when it finishes.');
        await delay(50);
      }
    }
    const owner = await handle.stat();
    try {
      await handle.writeFile(`${process.pid}\n`);
      return await action();
    } finally {
      await handle.close();
      const current = await statIfPresent(lock);
      if (current?.ino === owner.ino && current.dev === owner.dev) await fs.unlink(lock);
    }
  }

  async writeBatch(input) {
    object(input, 'batch', ['ifProjectRevision', 'records']);
    if (input.ifProjectRevision !== undefined) assert(typeof input.ifProjectRevision === 'string' && REVISION.test(input.ifProjectRevision), 'ifProjectRevision must be a project revision.');
    array(input.records, 'batch.records', 100);
    const ids = new Set(input.records.map(change => {
      id(change?.id, 'record ID');
      return change.id;
    }));
    return this.locked(async () => {
      const { project, revision } = await this.manifest();
      if (input.ifProjectRevision && input.ifProjectRevision !== revision) throw revisionConflict('The project rules');
      const { items, problems } = await this.catalog(ids);
      const unreadable = problems.find(problem => ids.has(RECORD_FILE.exec(path.basename(problem.file))[1]));
      if (unreadable) throw new Error(`${unreadable.file}: ${unreadable.message}`);
      const index = await this.readIndex();
      const { documents } = await this.documentIndex(items, index);
      for (const recordId of ids) assert(!index.paths.has(recordId) && !index.evidence.has(recordId), `The document index already uses ID ${recordId}.`);
      const changes = this.prepareBatch(input.records, project, items, documents);
      return { projectRevision: revision, records: await this.writeChanges(changes) };
    });
  }

  async writeChanges(changes) {
    const written = [];
    for (const item of changes) {
      const target = path.join(this.root, item.relativePath);
      if (item.bytes) {
        const directory = path.dirname(target);
        assert(await this.directory(directory, true), `Missing record folder: ${directory}.`);
        await atomicWrite(target, item.bytes, { mode: item.mode, beforeCommit: async () => {
          const current = await this.findRecord(item.record.id);
          if (current && pathKey(current) !== pathKey(target)) throw revisionConflict(item.record.id);
          const entry = await statIfPresent(target);
          if (entry && !entry.isFile()) throw revisionConflict(item.record.id);
          const currentRevision = entry ? digest((await readBytes(target)).bytes) : null;
          if (currentRevision !== item.before) throw revisionConflict(item.record.id);
        } });
      }
      written.push({ id: item.record.id, revision: item.revision, relativePath: item.relativePath, changed: Boolean(item.bytes) });
    }
    return written;
  }

  async importArchive(sourceId, token) {
    id(sourceId, 'archive source ID');
    assert(this.indexPath, `Archive imports require ${MANIFEST}.`);
    if (token !== undefined) assert(typeof token === 'string' && REVISION.test(token), 'Confirm the archive import using its preview token.');
    const run = async () => {
      const current = await this.manifest();
      assert(current.project.evidenceSources?.some(source => source.id === sourceId), `Unknown archive source: ${sourceId}.`);
      const directory = await sourceDirectory(this.root, sourceId);
      const { items, problems } = await this.catalog();
      const index = await this.readIndex();
      const { preview, changes, references, bodies, proposed } = await planArchive({ directory, sourceId, current, items, problems, index });
      if (token === undefined) return preview;
      if (!changes.length) return { projectRevision: current.revision, records: [] };
      if (token !== preview.token) throw revisionConflict('The archive import plan');
      for (const change of changes) {
        const old = items.get(change.id);
        if (!old) { change.body = bodies.get(change.id); continue; }
        const full = await this.readFile(path.join(this.root, old.relativePath), change.id);
        if (full.revision !== old.revision) throw revisionConflict(change.id);
        if (full.record.run?.importedBodyRevision === digest(Buffer.from(full.body))) change.body = bodies.get(change.id);
        items.set(change.id, full);
      }
      const evidence = new Map([...index.evidence, ...references]);
      const { documents } = await this.documentIndex(items, { ...index, evidence });
      const nextProject = validateProject(proposed);
      const records = this.prepareBatch(changes, nextProject, items, documents, MAX_RUNS);
      const projectRevision = nextProject === current.project ? current.revision : await this.writeManifest(nextProject, current);
      if (!isDeepStrictEqual(evidence, index.evidence)) await this.writeIndex({ ...index, evidence });
      return { projectRevision, records: await this.writeChanges(records) };
    };
    return token === undefined ? run() : this.locked(run);
  }

  async writeManifest(project, { mode, revision }) {
    const bytes = encodeJson(project);
    await atomicWrite(this.manifestPath, bytes, { mode, beforeCommit: async () => {
      if ((await this.manifest()).revision !== revision) throw revisionConflict('The project rules');
    } });
    return digest(bytes);
  }

  async configure(input) {
    object(input, 'configuration', ['ifRevision', 'project']);
    const proposed = validateProject(input.project);
    return this.locked(async () => {
      const { project, revision, mode } = await this.manifest();
      if (isDeepStrictEqual(project, proposed)) return { project, revision, changed: false };
      if (input.ifRevision !== revision) throw revisionConflict('The project rules');
      assert(proposed.id === project.id, 'The project ID is stable.');
      const { items, problems } = await this.catalog();
      assert(!problems.length, `Read or repair ${problems[0]?.file} before changing project rules.`);
      for (const { record } of items.values()) {
        const oldIssues = relationshipIssues(record, project);
        const added = relationshipIssues(record, proposed).find(issue => !oldIssues.includes(issue));
        if (added) throw new Error(`${record.id}: ${added}`);
      }
      const { evidence } = await this.readIndex();
      for (const { sourceId } of evidence.values()) {
        assert(!project.evidenceSources?.some(source => source.id === sourceId) || proposed.evidenceSources?.some(source => source.id === sourceId),
          `Source ${sourceId} still has indexed evidence.`);
      }
      return { project: proposed, revision: await this.writeManifest(proposed, { mode, revision }), changed: true };
    });
  }

  async saveDocument(document, save, overwrite) {
    const recordId = RECORD_FILE.exec(path.basename(document.path))[1];
    return this.locked(async () => {
      const { project } = await this.manifest();
      const target = document.path;
      assert(await this.directory(path.dirname(target)), 'The records folder has moved. Open the project again.');
      const current = await this.findRecord(recordId);
      if (current && pathKey(current) !== pathKey(target)) throw new RevisionConflictError(target);
      const entry = await statIfPresent(target);
      assert(!entry || entry.isFile(), 'The record path must be a regular file.');
      const revision = entry ? digest((await readBytes(target)).bytes) : null;
      if (!overwrite && revision !== document.revision) throw new RevisionConflictError(target);
      const { items } = await this.catalog();
      const index = await this.readIndex();
      assert(!index.paths.has(recordId) && !index.evidence.has(recordId), `The document index already uses ID ${recordId}.`);
      const { documents } = await this.documentIndex(items, index);
      const { record } = parseMarkdown(document.content.replace(/\r\n/g, '\n'), recordId);
      validateChange(record, items.get(recordId)?.record, project, documents);
      return save();
    });
  }

  prepareBatch(input, project, items, documents, limit = 100) {
    array(input, 'batch.records', limit);
    const seen = new Set();
    const pending = new Set(input.map(change => change.id));
    return input.map(change => {
      object(change, 'record change', ['id', 'ifRevision', 'type', 'title', 'date', 'phaseId', 'coverage', 'sources', 'fields', 'body', 'evidence', 'relations', 'run', 'relatedProjects']);
      id(change.id, 'record ID');
      assert(!seen.has(change.id), `Use one change per record in a batch: ${change.id}.`);
      seen.add(change.id);
      if (change.ifRevision != null) assert(typeof change.ifRevision === 'string' && REVISION.test(change.ifRevision), 'ifRevision must be a record revision or null.');
      const existing = items.get(change.id);
      const { ifRevision, fields: patch, body, ...metadata } = change;
      const type = project.recordTypes.find(item => item.id === (metadata.type ?? existing?.record.type));
      const defaults = Object.fromEntries((type?.fields || []).filter(rule => rule.default !== undefined).map(rule => [rule.id, rule.default]));
      const fields = Object.entries(existing?.record.fields ?? defaults);
      const merged = new Map(fields);
      if (patch !== undefined) {
        object(patch, 'record.fields');
        for (const [key, value] of Object.entries(patch)) {
          id(key, 'record.fields key');
          if (value === null) merged.delete(key);
          else merged.set(key, value);
        }
      }
      const record = validateRecord({ ...existing?.record, ...metadata, fields: Object.fromEntries(merged) }, change.id);
      if (body !== undefined) assert(typeof body === 'string' && !body.includes('\0'), 'body must be Markdown text.');
      validateChange(record, existing?.record, project, documents, pending);
      const markdown = body?.replace(/\r\n/g, '\n') ?? existing?.body ?? templateBody(record, project, documents, this.sourceHref);
      if (existing && isDeepStrictEqual(existing.record, record) && existing.body === markdown) return existing;
      if ((ifRevision ?? null) !== (existing?.revision ?? null)) throw revisionConflict(change.id);
      const normalized = formatMarkdown(record, markdown);
      parseMarkdown(normalized, record.id);
      const encoded = existing?.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
      const bytes = Buffer.from((existing?.bom ? '\uFEFF' : '') + encoded);
      assert(bytes.length <= MAX_DOCUMENT_BYTES, 'The Markdown record exceeds 16 MB.');
      const directory = this.summaryPath && record.coverage ? SUMMARIES : RECORDS;
      const item = {
        record, body: markdown, bytes, revision: digest(bytes), before: existing?.revision ?? null,
        relativePath: existing?.relativePath ?? `${directory}/${fileName(record.id)}`, mode: existing?.mode,
      };
      items.set(record.id, item);
      documents.set(record.id, recordReference(item));
      return item;
    });
  }
}

function encodeJson(value, limit = MAX_JSON_BYTES) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  assert(bytes.length <= limit, `Research project JSON exceeds ${limit / 1024} KiB.`);
  return bytes;
}

const projectGuide = `# mekiR 研究项目的 Agent 指引

## 读取当前项目

每批写入前先运行 \`node "<mekiR 源码目录>/electron/research-cli.cjs" describe "<项目根目录>"\`。读取 \`project.instructions\`，按 \`project.recordTypes\` 中的 ID 选择记录类型，再使用该类型的字段和模板。项目可以各自定义实验、分析、写作记录或总结。

在 \`fields\` 中使用字段 ID。按字段说明从实际产物取值，遵守类型、单位、范围与必填要求。枚举使用 \`options\` 中的原值。用正文说明缺失数据及原因。若必填项缺少有效值和可用默认值，先补证据。

## 写入记录

1. 用 \`list\` 查找同一轮运行，复用稳定记录 ID。用 \`read <目录> <ID>\` 获取已有的字段、正文和 \`revision\`。发生日期采用项目时区的实际日期。
2. 用 \`batch <目录> --input <文件或 ->\` 提交 \`ifProjectRevision\` 和 \`records\`。前者取自 \`describe.revision\`。新记录提交 \`id\`、\`ifRevision: null\`、\`type\`、\`title\`、\`date\` 及所需属性。已有记录提交 \`id\`、\`read.revision\` 作为 \`ifRevision\`，以及要修改的内容。
3. 新建时，省略已配置默认值的字段会使用默认值，省略 \`body\` 会套用模板。更新时，省略的字段和正文保留原值。要主动清除可选字段，在 \`fields\` 中把该字段设为 \`null\`。收到 \`RESEARCH_CONFLICT\` 后重新读取规则和相关记录，再合并重试。

## 引用依据和撰写总结

用 \`list\` 的 \`documents\` 或 \`resolve <目录> <ID>\` 查找文档。用 \`index <目录> <ID> --path <相对路径>\` 登记普通文档，正文用 \`[标题](mekir:<ID>)\` 引用。外部目录用 \`bind-source\` 绑定，外部证据用 \`index --source <来源 ID>\` 登记。记录可用 \`evidence\` 保存证据 ID，并用 \`relations\` 保存 \`kind\`、\`target\` 和可选的 \`note\`。

总结的 \`type\` 取自本项目 \`kind\` 为 \`summary\` 的记录类型 ID。用 \`date\` 记撰写日期，用 \`coverage.start\` 和 \`coverage.end\` 记覆盖区间，首尾日期均计入。用 \`sources\` 引用依据，同一批次先写入新来源，再写总结。用 \`relatedProjects\` 保存其他项目的 ID，在总结的原项目更新同一条记录。

导入归档时用 \`import-archive\` 预览，核对新增、变化和缺件后提交返回的 token。导入信息保存在 \`run\` 中，项目字段可按现有规则用 \`batch\` 补录。用 \`list --query\`、\`--month\`、\`--field\` 或 \`--filter\` 查询相关记录。

## 修改字段、模板和视图

从 \`describe.project\` 复制配置，按任务需求修改 \`instructions\`、记录类型、字段、模板、阶段或视图。用 \`configure <目录> --input <文件或 ->\` 提交包含 \`ifRevision\` 和 \`project\` 的对象，\`ifRevision\` 取自 \`describe.revision\`。

调整显示名称时沿用原 ID。字段的含义或单位变化时使用新 ID，并同步更新模板里的 \`{{field.<ID>}}\` 和视图的 \`fieldIds\`。配置保存后重新 \`describe\`，用 \`list\` 的 \`issues\` 检查历史记录，再按需用 \`batch\` 补录。项目规则放在配置的 \`instructions\`，项目协作流程可在这份 \`AGENTS.md\` 中维护。
`;

module.exports = { ResearchStore };

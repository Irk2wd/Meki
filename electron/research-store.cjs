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

const projectGuide = `# 为 mekiR 研究项目工作的 agent

每批实验完成后，先运行 \`node <mekiR 源码目录>/electron/research-cli.cjs describe <本项目目录>\`，读取本项目当前的记录类型、字段规则、模板、视图和 instructions。用 \`list\` 查询已有记录，用 \`read <目录> <ID>\` 查看正文与 revision。

将实测结果整理成 JSON，再用 \`batch <目录> --input <JSON 文件>\` 写入。为同一次运行保留稳定 ID，使用当天实际发生的日期，新建时可省略正文以套用模板。更新已有记录时传入由 read 返回的 ifRevision。用 describe 返回的 revision 作为 ifProjectRevision。资料缺失时保留缺失信息，正文可链接原始结果。

阶段总结使用该项目配置的 summary 类型。date 是撰写日期，coverage 是回顾区间，sources 是作为依据的文档 ID。若来源与总结一起提交，将来源放在 batch.records 中的前面。来源 ID 可通过 list 的 documents 或 \`resolve <目录> <ID>\` 查找。用 \`index <目录> <ID> --path <项目内相对路径>\` 登记普通文档。正文可用 \`[标题](mekir:<ID>)\` 引用同一项目的已索引文档。

用阶段总结的 relatedProjects 关联多个项目。填入从各目标项目 describe 读取的项目 ID，在总结的原项目执行 batch，继续使用同一个记录 ID 和正文文件。

外部论文和归档目录用 \`bind-source\` 登记，用 \`index --source <来源 ID>\` 登记证据。记录的 evidence 保存证据 ID，relations 保存 kind、target 和可选 note。kind 的可选值从 describe 读取。实验归档用 \`import-archive\` 预览，核对新增、变化和缺件后再用返回的 token 确认。用 \`list --query\`、\`--month\`、\`--field\` 或 \`--filter\` 查找相关实验。

调整项目方案时，从 describe 的 project 开始，按需修改 recordTypes、fields、template、phases、views 或 defaultView，再用 \`configure <目录> --input <JSON 文件>\` 提交包含 ifRevision 和 project 的对象。冲突时重新读取最新内容并合并。已写入的正文可以继续用 mekiR 打开编辑。
`;

module.exports = { ResearchStore };

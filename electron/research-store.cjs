'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite, readBytes, decodeDocument, digest, pathKey, MAX_DOCUMENT_BYTES, RevisionConflictError } = require('./file-store.cjs');
const {
  MANIFEST, RECORDS, RECORD_FILE, REVISION, assert, object, array, id, date, validateProject, validateRecord,
  relationshipIssues, fieldIssues, validateChange, parseMarkdown, formatMarkdown, fileName, templateBody,
} = require('./research-model.cjs');

const MAX_MANIFEST_BYTES = 512 * 1024;

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

class ResearchStore {
  constructor(root) {
    this.root = root;
    this.manifestPath = path.join(root, MANIFEST);
    this.recordsPath = path.join(root, RECORDS);
  }

  static async open(root) {
    const project = new ResearchStore(await fs.realpath(root));
    const entry = await statIfPresent(project.manifestPath);
    if (!entry) return null;
    assert(entry.isFile(), `${MANIFEST} must be a regular file in the project folder.`);
    return project;
  }

  static async forDocument(file) {
    const directory = path.dirname(file);
    if (path.basename(directory) !== RECORDS || !RECORD_FILE.test(path.basename(file))) return null;
    const root = path.dirname(directory);
    const project = await ResearchStore.open(root);
    if (project) assert(pathKey(root) === pathKey(project.root), 'Open the project folder at its original location.');
    return project;
  }

  static async initialize(root, project, seed = []) {
    const validated = validateProject(project);
    const manifest = encodeManifest(validated);
    const changes = prepareBatch(seed, validated, new Map());
    const destination = path.join(await fs.realpath(path.dirname(root)), path.basename(root));
    await fs.mkdir(destination);
    const store = new ResearchStore(destination);
    await fs.mkdir(store.recordsPath);
    for (const item of changes) await atomicWrite(store.recordPath(item.record.id), item.bytes);
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
    const entry = await statIfPresent(this.manifestPath);
    assert(entry?.isFile(), `${MANIFEST} must be a regular file in the project folder.`);
    const { bytes, mode } = await readBytes(this.manifestPath, MAX_MANIFEST_BYTES);
    let project;
    try { project = JSON.parse(decodeDocument(bytes).content); }
    catch (error) { throw new Error(`Could not read ${MANIFEST}: ${error.message}`); }
    return { project: validateProject(project), revision: digest(bytes), mode };
  }

  async recordsDirectory(create = false) {
    await this.assertRoot();
    if (create) await fs.mkdir(this.recordsPath).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await statIfPresent(this.recordsPath);
    if (!entry) return false;
    assert(entry.isDirectory() && pathKey(await fs.realpath(this.recordsPath)) === pathKey(this.recordsPath), 'records must be a folder inside the project.');
    return true;
  }

  recordPath(recordId) {
    return path.join(this.recordsPath, fileName(recordId));
  }

  manages(file) {
    return pathKey(file) === pathKey(this.recordsPath) || (
      pathKey(path.dirname(file)) === pathKey(this.recordsPath) && RECORD_FILE.test(path.basename(file))
    );
  }

  async readFile(recordId) {
    const target = this.recordPath(recordId);
    const entry = await statIfPresent(target);
    assert(entry?.isFile(), `Record ${recordId} does not exist as a regular Markdown file.`);
    const { bytes, mode } = await readBytes(target);
    const { content, newline, bom } = decodeDocument(bytes);
    return {
      ...parseMarkdown(content, recordId), revision: digest(bytes), mode, newline, bom,
      relativePath: `${RECORDS}/${fileName(recordId)}`,
    };
  }

  async read(recordId) {
    id(recordId, 'record ID');
    assert(await this.recordsDirectory(), 'This project has no records.');
    return publicRecord(await this.readFile(recordId));
  }

  async catalog(bodyIds = new Set()) {
    const items = new Map();
    const problems = [];
    if (!await this.recordsDirectory()) return { items, problems };
    const files = (await fs.readdir(this.recordsPath)).sort();
    for (const file of files) {
      const match = RECORD_FILE.exec(file);
      if (!match) continue;
      try {
        const item = await this.readFile(match[1]);
        if (!bodyIds.has(match[1])) delete item.body;
        items.set(match[1], item);
      }
      catch (error) { problems.push({ file: `${RECORDS}/${file}`, message: error.message }); }
    }
    return { items, problems };
  }

  async snapshot() {
    const { project, revision } = await this.manifest();
    const { items, problems } = await this.catalog();
    const records = [...items.values()].map(({ record, revision, relativePath }) => ({
      record, revision, relativePath,
      issues: [
        ...relationshipIssues(record, project),
        ...fieldIssues(record, project.recordTypes.find(type => type.id === record.type)).map(issue => issue.message),
        ...(record.sources || []).filter(source => !items.has(source)).map(source => `Missing source record: ${source}.`),
      ],
    }));
    return { root: this.root, project, revision, records, problems };
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
      const changes = prepareBatch(input.records, project, items);
      if (changes.some(item => item.bytes)) await this.recordsDirectory(true);
      const written = [];
      for (const item of changes) {
        const target = this.recordPath(item.record.id);
        if (item.bytes) {
          await atomicWrite(target, item.bytes, { mode: item.mode, beforeCommit: async () => {
            await this.recordsDirectory();
            const entry = await statIfPresent(target);
            if (entry && !entry.isFile()) throw revisionConflict(item.record.id);
            const currentRevision = entry ? digest((await readBytes(target)).bytes) : null;
            if (currentRevision !== item.before) throw revisionConflict(item.record.id);
          } });
        }
        written.push({ id: item.record.id, revision: item.revision, relativePath: item.relativePath, changed: Boolean(item.bytes) });
      }
      return { projectRevision: revision, records: written };
    });
  }

  async configure(input) {
    object(input, 'configuration', ['ifRevision', 'project']);
    const proposed = validateProject(input.project);
    const bytes = encodeManifest(proposed);
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
      await atomicWrite(this.manifestPath, bytes, { mode, beforeCommit: async () => {
        if ((await this.manifest()).revision !== revision) throw revisionConflict('The project rules');
      } });
      return { project: proposed, revision: digest(bytes), changed: true };
    });
  }

  async saveDocument(document, save, overwrite) {
    const recordId = RECORD_FILE.exec(path.basename(document.path))[1];
    return this.locked(async () => {
      const { project } = await this.manifest();
      assert(await this.recordsDirectory(), 'The records folder has moved. Open the project again.');
      const target = this.recordPath(recordId);
      const entry = await statIfPresent(target);
      assert(!entry || entry.isFile(), 'The record path must be a regular file.');
      const revision = entry ? digest((await readBytes(target)).bytes) : null;
      if (!overwrite && revision !== document.revision) throw new RevisionConflictError(target);
      const { items } = await this.catalog();
      const { record } = parseMarkdown(document.content.replace(/\r\n/g, '\n'), recordId);
      validateChange(record, items.get(recordId)?.record, project, items);
      return save();
    });
  }
}

function encodeManifest(project) {
  const bytes = Buffer.from(JSON.stringify(project, null, 2) + '\n');
  assert(bytes.length <= MAX_MANIFEST_BYTES, 'The project rules exceed 512 KiB.');
  return bytes;
}

function prepareBatch(input, project, current) {
  array(input, 'batch.records', 100);
  const items = new Map(current);
  const seen = new Set();
  return input.map(change => {
    object(change, 'record change', ['id', 'ifRevision', 'type', 'title', 'date', 'phaseId', 'coverage', 'sources', 'fields', 'body']);
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
    validateChange(record, existing?.record, project, items);
    const markdown = body?.replace(/\r\n/g, '\n') ?? existing?.body ?? templateBody(record, project, items);
    if (existing && isDeepStrictEqual(existing.record, record) && existing.body === markdown) return existing;
    if ((ifRevision ?? null) !== (existing?.revision ?? null)) throw revisionConflict(change.id);
    const normalized = formatMarkdown(record, markdown);
    parseMarkdown(normalized, record.id);
    const encoded = existing?.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
    const bytes = Buffer.from((existing?.bom ? '\uFEFF' : '') + encoded);
    assert(bytes.length <= MAX_DOCUMENT_BYTES, 'The Markdown record exceeds 16 MB.');
    const item = {
      record, body: markdown, bytes, revision: digest(bytes), before: existing?.revision ?? null,
      relativePath: `${RECORDS}/${fileName(record.id)}`, mode: existing?.mode,
    };
    items.set(record.id, item);
    return item;
  });
}

const projectGuide = `# 为 mekiR 研究项目工作的 agent

每批实验完成后，先运行 \`node <mekiR 源码目录>/electron/research-cli.cjs describe <本项目目录>\`，读取本项目当前的记录类型、字段规则、模板、视图和 instructions。用 \`list\` 查询已有记录，用 \`read <目录> <ID>\` 查看正文与 revision。

将实测结果整理成 JSON，再用 \`batch <目录> --input <JSON 文件>\` 写入。为同一次运行保留稳定 ID，使用当天实际发生的日期，新建时可省略正文以套用模板。更新已有记录时传入由 read 返回的 ifRevision。用 describe 返回的 revision 作为 ifProjectRevision。资料缺失时保留缺失信息，正文可链接原始结果。

阶段总结使用该项目配置的 summary 类型。date 是撰写日期，coverage 是回顾区间，sources 是作为依据的记录 ID。若来源与总结一起提交，将来源放在 batch.records 中的前面。

调整项目方案时，从 describe 的 project 开始，按需修改 recordTypes、fields、template、phases、views 或 defaultView，再用 \`configure <目录> --input <JSON 文件>\` 提交包含 ifRevision 和 project 的对象。冲突时重新读取最新内容并合并。已写入的正文可以继续用 mekiR 打开编辑。
`;

module.exports = { ResearchStore };

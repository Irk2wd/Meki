'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite, readBytes, decodeDocument, digest, isDocumentPath, isWithin, pathKey, MAX_DOCUMENT_BYTES, RevisionConflictError } = require('./file-store.cjs');
const { WorkspaceStore } = require('./workspace-store.cjs');
const { bindDirectory, boundSources, sourceDirectory, evidencePath } = require('./research-evidence.cjs');
const { researchMatcher } = require('./research-filter.cjs');
const { captureFieldRules, readFieldOrigins, saveFieldRules } = require('./research-field-history.cjs');
const { planArchive, MAX_RUNS } = require('./research-import.cjs');
const { comparisonImages } = require('./research-comparison.mjs');
const {
  METADATA, MANIFEST, LEGACY_MANIFEST, INDEX, SUMMARIES, DOCUMENT_SCHEME, RECORDS, RECORD_FILE, REVISION, RECORD_TIERS,
  assert, object, array, id, validateProject, validateRecord,
  validateSource, validateEvidence, validateFilter,
  comparisonType,
  relationshipIssues, fieldIssues, validateChange, parseMarkdown, formatMarkdown, fileName, templateBody,
} = require('./research-model.cjs');

const { localSearchGuide, smartSearchGuide, filingSection, detectGuidanceConflicts, upgradeGuideText, upgradeProjectRules } = require('./research-guidance.cjs');
const { readTrialLog } = require('./research-trials.cjs');

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
  const { record, revision, relativePath, body, fieldOrigins } = item;
  return { record, revision, relativePath, body, ...(fieldOrigins && { fieldOrigins }) };
}

function recordReference({ record, relativePath }) {
  return { id: record.id, title: record.title, date: record.date, relativePath };
}

function firstSentence(value) {
  const [start] = /^.{0,120}/u.exec(value.trimStart());
  return start.split(/(?<=[。！？])|(?<=[.!?])\s/, 1)[0].trimEnd();
}

const findingHeading = /^(?:结论|主要结论|已确认|(?:已确认|已验证|确定性)(?:的)?(?:结论|结果|发现)|conclusions?|(?:(?:confirmed|verified|key) )?findings|(?:confirmed|verified) results)$/i;
const pendingHeading = /^(?:待(?:验证|确认)(?:事项|问题)?|未决问题|下一步|不确定性|open questions?|next steps?|to verify|uncertainties)$/i;

function progressExcerpt(body, preferConclusion = false) {
  let fence = '';
  let first = '';
  const sections = [];
  const text = preferConclusion ? body : body.slice(0, 8192);
  for (const [raw] of text.matchAll(/[^\n]+/g)) {
    const line = raw.trim();
    const marker = line.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence)) fence = '';
      continue;
    }
    if (fence || !line) continue;
    const heading = /^(#{1,6})(?:\s+(.*)|$)/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const title = (heading[2] || '').replace(/\s+#+$/, '');
      while (sections.length && sections.at(-1).depth >= depth) sections.pop();
      let kind = sections.at(-1)?.kind || 'prose';
      if (preferConclusion && (kind === 'pending' || pendingHeading.test(title))) kind = 'pending';
      else if (findingHeading.test(title)) kind = 'finding';
      else if (/^(?:结论与下一步|conclusions? and next steps)$/i.test(title)) kind = 'mixed';
      sections.push({ depth, kind });
      continue;
    }
    const kind = sections.at(-1)?.kind;
    if (kind === 'pending' || (first && kind !== 'finding')) continue;
    const prose = kind === 'finding' || kind === 'mixed' ? line.replace(/^(?:[-+*]|\d+[.)])\s+/, '') : line;
    if (/^(?:[|<>!]|[-+*]\s|[-=_*]{3,}$|\d+[.)]\s)/.test(prose)) continue;
    const plain = prose.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)(.+?)\1/g, '$2').trim();
    if (plain) {
      if (!preferConclusion || kind === 'finding') return firstSentence(plain);
      first = firstSentence(plain);
    }
  }
  return first;
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

const operationalNoisePattern = /(?:^|[-_\s])(?:smoke|invalid|fail(?:ed|ure)?|abort(?:ed)?|broken|crash(?:ed)?)(?:[-_\s]|$)|试跑|采集无效|无效运行|初[次轮]失败|首轮失败|失败后修复|中止|中断/i;
const retrySuffixPattern = /^(.*?)(?:[-_](?:v[2-9]|v\d{2,}|retry\d*|rerun\d*|smoke(?:[-_]v\d+)?|invalid(?:[-_]v\d+)?))$/i;
const setupFirstHeadingPattern = /^(?:背景|前置条件|实验背景|实验设置|实验配置|实验条件|评测协议|协议与设置|参数设置|参数配置|配置|环境|测试环境|setup|protocol|background|configuration|environment|experimental setup)$/i;

function firstResultVisualOffset(body) {
  const image = body.search(/!\[[^\]]*\]\([^)]+\)/);
  const table = body.search(/^\|[^\n]+\|\s*\n\|[\s:|-]+\|/m);
  const candidates = [image, table].filter(index => index >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

function hasBuriedResults(body) {
  if (!body || body.length < 600) return false;
  const firstHeading = body.match(/^##\s+([^\n]+)/m)?.[1]?.trim() || '';
  const visualIndex = firstResultVisualOffset(body);
  if (setupFirstHeadingPattern.test(firstHeading) && (visualIndex >= 0 || /^##\s+(?:结论|主要结论|关键图表|核心数据|结果|conclusions?|results?|findings?)/im.test(body))) {
    return true;
  }
  if (visualIndex >= 800) {
    const lead = body.slice(0, visualIndex).replace(/^#[^\n]*\n+/m, '').trim();
    if (lead.length >= 650) return true;
  }
  return false;
}

function normalizeTitleForMatch(title) {
  return String(title || '').normalize('NFKC').toLowerCase()
    .replace(/\b(?:v\d+|smoke|invalid|retry\d*|rerun\d*)\b/g, ' ')
    .replace(/(?:试跑|复测|复跑|重跑|采集无效|首轮失败|初次失败)/g, ' ')
    .replace(/[\s·\-_/()（）\[\]【】:：,，。.?？!！]+/g, ' ').trim();
}

function batchWarnings(inputRecords, changes, existingItems, project) {
  const warnings = [];
  const kinds = new Map(project.recordTypes.map(type => [type.id, type.kind]));
  const createdEntries = [];
  let createdComparisons = 0;
  const knownByPhase = new Map();
  const knownIds = new Set();
  for (const item of existingItems.values()) {
    const rec = item.record;
    knownIds.add(rec.id);
    if (kinds.get(rec.type) !== 'entry' || rec.tier === 'log') continue;
    const key = rec.phaseId || '';
    const norm = normalizeTitleForMatch(rec.title);
    if (!norm) continue;
    if (!knownByPhase.has(key)) knownByPhase.set(key, []);
    knownByPhase.get(key).push({ id: rec.id, title: rec.title, norm });
  }
  for (let i = 0; i < inputRecords.length; i++) {
    const change = inputRecords[i];
    const item = changes[i];
    if (!item) continue;
    const record = item.record;
    const kind = kinds.get(record.type);
    const tier = record.tier || 'standard';
    if (kind === 'entry' && tier !== 'log' && change.body !== undefined && hasBuriedResults(item.body)) {
      warnings.push({
        code: 'RESULTS_BURIED',
        recordId: record.id,
        message: `记录「${record.title}」前部铺垫了过多前置条件或背景，关键图表与核心数据表出现过晚。`,
        suggestion: '请将 1–3 句核心结论和最能直观体现效果的关键图表、对比数据表放在正文最前面；把相机/光照/参数/环境/审计等实验设置后置到「实验设置与适用范围」。',
      });
    }
    if (existingItems.has(change.id)) continue;
    if (kind === 'comparison') { createdComparisons++; continue; }
    if (kind !== 'entry' || tier === 'log') continue;
    createdEntries.push(record);
    if (operationalNoisePattern.test(record.id) || operationalNoisePattern.test(record.title)) {
      warnings.push({
        code: 'OPERATIONAL_NOISE',
        recordId: record.id,
        message: `新记录「${record.title}」像是一次试跑、工程故障或无效采集，但层级为 ${tier}。`,
        suggestion: '纯工程报错或作废试跑不建议单独建顶层实验；若确需保留过程日志，请将 tier 设为 "log" 并用 relations (part-of) 挂到主问题记录，或合并进母记录的「实验试次」表。',
      });
    }
    if (!record.phaseId && project.phases.length > 0) {
      warnings.push({
        code: 'MISSING_PHASE',
        recordId: record.id,
        message: `新记录「${record.title}」未指定 phaseId。`,
        suggestion: '请参考 describe.phaseContext 归入对应阶段，或将原始过程归档设为 tier: "log"。',
      });
    }
    const norm = normalizeTitleForMatch(record.title);
    const siblings = new Set();
    for (const candidate of knownByPhase.get(record.phaseId || '') || []) {
      if (candidate.id !== record.id && norm && candidate.norm === norm) siblings.add(candidate.id);
    }
    const baseMatch = retrySuffixPattern.exec(record.id);
    if (baseMatch && baseMatch[1].length >= 6) {
      const prefix = baseMatch[1];
      for (const existingId of knownIds) {
        if (existingId !== record.id && (existingId === prefix || existingId.startsWith(`${prefix}-`))) siblings.add(existingId);
      }
    }
    if (siblings.size) {
      const relatedIds = [...siblings].slice(0, 5);
      warnings.push({
        code: 'POSSIBLE_DUPLICATE_OR_RETRY',
        recordId: record.id,
        relatedIds,
        message: `新记录「${record.title}」与已有记录高度相似或带有迭代后缀，疑似同一研究问题的复测/重跑。`,
        suggestion: `优先复用已有记录（${relatedIds.join(', ')}），在「实验试次」表追加新行并更新顶部结论；如确为独立子问题，请用标题明确区分检验的变量。`,
      });
    }
    if (norm) {
      const key = record.phaseId || '';
      if (!knownByPhase.has(key)) knownByPhase.set(key, []);
      knownByPhase.get(key).push({ id: record.id, title: record.title, norm });
    }
    knownIds.add(record.id);
  }
  if (createdEntries.length >= 5) {
    warnings.push({
      code: 'BULK_FRAGMENTATION',
      message: `本批次一次新建了 ${createdEntries.length} 条非 log 级实验记录。`,
      suggestion: '同一研究问题的多组参数、子步骤或逐模型运行应合并到主记录的「实验试次」表；若是批量过程日志，请将 tier 设为 "log"。',
    });
  }
  if (createdComparisons >= 3) {
    warnings.push({
      code: 'EXCESSIVE_COMPARISONS',
      message: `本批次一次新建了 ${createdComparisons} 条顶层可视化展示（comparison）记录。`,
      suggestion: '常规诊断图请直接嵌入实验记录正文，仅对关键定稿或跨方案核心结论建立顶层可视化展示。',
    });
  }
  return warnings;
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
    for (const item of changes) {
      await saveFieldRules(store, item.record, item.ruleBytes);
      await atomicWrite(path.join(destination, item.relativePath), item.bytes);
    }
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

  async readFile(target, recordId, includeRules = false, cache) {
    const entry = await statIfPresent(target);
    assert(entry?.isFile(), `Record ${recordId} does not exist as a regular Markdown file.`);
    const { bytes, mode } = await readBytes(target);
    const { content, newline, bom } = decodeDocument(bytes);
    const document = parseMarkdown(content, recordId);
    return {
      ...document, revision: digest(bytes), mode, newline, bom,
      fieldOrigins: includeRules ? await readFieldOrigins(this, document.record, cache) : undefined,
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
    const item = publicRecord(await this.readFile(target, recordId, true));
    const { project } = await this.manifest();
    const type = project.recordTypes.find(type => type.id === item.record.type);
    if (Object.keys(item.record.fields).length) {
      item.currentFields = type?.fields.filter(rule => Object.hasOwn(item.record.fields, rule.id)) || [];
    }
    if (type?.kind === 'entry') {
      const { trials } = readTrialLog(item.body);
      if (trials.length) item.trials = trials;
    }
    return item;
  }

  async catalog(bodyIds = new Set(), matches, excerptTypes) {
    const items = new Map();
    const rules = new Map();
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
          const item = await this.readFile(target, recordId, Boolean(excerptTypes) || bodyIds.has(recordId), rules);
          if (excerptTypes) {
            const type = excerptTypes.get(item.record.type);
            if (type?.kind === 'entry') {
              const { trials, issues } = readTrialLog(item.body);
              if (trials.length) item.trials = trials;
              if (issues.length) item.trialIssues = issues;
            }
            const field = type?.conclusionField && item.record.fields[type.conclusionField];
            item.excerpt = (typeof field === 'string' && firstSentence(field)) || progressExcerpt(item.body, type?.kind === 'entry' || type?.kind === 'summary');
          }
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
    const { items, problems, matchingIds } = await this.catalog(new Set(), filter && researchMatcher(validateFilter(filter), project),
      new Map(project.recordTypes.map(type => [type.id, type])));
    const index = await this.documentIndex(items, await this.readIndex());
    const records = [...items.values()].map(({ record, revision, relativePath, excerpt, fieldOrigins, trials, trialIssues }) => ({
      record, revision, relativePath, ...(fieldOrigins && { fieldOrigins }), ...(excerpt ? { excerpt } : {}), ...(trials && { trials }),
      issues: [
        ...(trialIssues || []),
        ...relationshipIssues(record, project),
        ...fieldIssues(record, project.recordTypes.find(type => type.id === record.type)).map(issue => issue.message),
        ...(record.sources || []).filter(source => !index.documents.has(source)).map(source => `Missing source document: ${source}.`),
        ...[...(record.evidence || []), ...(record.run?.evidence || []), ...comparisonImages(record.comparison)].filter(file => !index.documents.get(file)?.sourceId).map(file => `Missing evidence: ${file}.`),
        ...(record.relations || []).filter(({ target }) => !index.documents.has(target)).map(({ target }) => `Missing relation target: ${target}.`),
      ],
    }));
    return {
      root: this.root, project, revision, manifestFile: this.manifestFile, comparisonType: comparisonType(project),
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
      const current = await this.manifest();
      const { project, revision } = current;
      if (input.ifProjectRevision && input.ifProjectRevision !== revision) throw revisionConflict('The project rules');
      const { items, problems } = await this.catalog(ids);
      const unreadable = problems.find(problem => ids.has(RECORD_FILE.exec(path.basename(problem.file))[1]));
      if (unreadable) throw new Error(`${unreadable.file}: ${unreadable.message}`);
      const index = await this.readIndex();
      const { documents } = await this.documentIndex(items, index);
      for (const recordId of ids) assert(!index.paths.has(recordId) && !index.evidence.has(recordId), `The document index already uses ID ${recordId}.`);
      const type = comparisonType(project);
      const registerType = input.records.some(record => record.comparison && record.type === type.id) &&
        !project.recordTypes.some(existing => existing.id === type.id);
      const next = registerType ? validateProject({ ...project, recordTypes: [...project.recordTypes, type] }) : project;
      const prior = new Map(items);
      const changes = this.prepareBatch(input.records, next, items, documents);
      const warnings = batchWarnings(input.records, changes, prior, next);
      const projectRevision = registerType ? await this.writeManifest(next, current) : revision;
      const records = await this.writeChanges(changes);
      return { projectRevision, records, ...(warnings.length ? { warnings } : {}) };
    });
  }

  async writeChanges(changes) {
    const written = [];
    for (const item of changes) {
      const target = path.join(this.root, item.relativePath);
      if (item.bytes) {
        const directory = path.dirname(target);
        assert(await this.directory(directory, true), `Missing record folder: ${directory}.`);
        await saveFieldRules(this, item.record, item.ruleBytes);
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
        const full = await this.readFile(path.join(this.root, old.relativePath), change.id, true);
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

  async guidanceChanges(current) {
    const project = upgradeProjectRules(current.project);
    const file = path.join(this.root, 'AGENTS.md');
    const entry = await statIfPresent(file);
    let guide;
    let content = '';
    if (entry?.isFile() && entry.size <= MAX_JSON_BYTES) {
      const { bytes, mode } = await readBytes(file, MAX_JSON_BYTES);
      content = bytes.toString('utf8');
      const updated = upgradeGuideText(content);
      if (updated !== content && Buffer.from(content).equals(bytes)) guide = { file, mode, before: digest(bytes), bytes: Buffer.from(updated) };
    }
    const conflicts = detectGuidanceConflicts(content, current.project);
    return { project, guide, conflicts, files: [...(project !== current.project ? [this.manifestFile] : []), ...(guide ? ['AGENTS.md'] : [])] };
  }

  async upgradeGuidance() {
    return this.locked(async () => {
      const current = await this.manifest();
      const { project, guide, files } = await this.guidanceChanges(current);
      if (guide) await atomicWrite(guide.file, guide.bytes, { mode: guide.mode, beforeCommit: async () => {
        if (!(await statIfPresent(guide.file))?.isFile() || digest((await readBytes(guide.file)).bytes) !== guide.before) throw revisionConflict('AGENTS.md');
      } });
      const revision = project === current.project ? current.revision : await this.writeManifest(validateProject(project), current);
      return { files, revision };
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
      const { items } = await this.catalog(new Set([recordId]));
      const index = await this.readIndex();
      assert(!index.paths.has(recordId) && !index.evidence.has(recordId), `The document index already uses ID ${recordId}.`);
      const { documents } = await this.documentIndex(items, index);
      const normalized = document.content.replace(/\r\n/g, '\n');
      const { record } = parseMarkdown(normalized, recordId);
      const previous = items.get(recordId);
      validateChange(record, previous?.record, project, documents);
      const submitted = record.fieldRules;
      const bytes = captureFieldRules(record, previous, project.recordTypes.find(type => type.id === record.type), record.fields);
      if (record.fieldRules === submitted) {
        await saveFieldRules(this, record, bytes);
        return save(document);
      }
      const content = normalized.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?=\n|$)/, () => `---\n${JSON.stringify(record, null, 2)}\n---`);
      parseMarkdown(content, recordId);
      await saveFieldRules(this, record, bytes);
      return save({ ...document, content });
    });
  }

  prepareBatch(input, project, items, documents, limit = 100) {
    array(input, 'batch.records', limit);
    const seen = new Set();
    const pending = new Set(input.map(change => change.id));
    return input.map(change => {
      object(change, 'record change', ['id', 'ifRevision', 'type', 'title', 'date', 'tier', 'phaseId', 'coverage', 'sources', 'fields', 'body', 'evidence', 'relations', 'run', 'relatedProjects', 'comparison']);
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
      const combined = { ...existing?.record, ...metadata, fields: Object.fromEntries(merged) };
      if (combined.tier === null) delete combined.tier;
      const record = validateRecord(combined, change.id);
      if (body !== undefined) assert(typeof body === 'string' && !body.includes('\0'), 'body must be Markdown text.');
      validateChange(record, existing?.record, project, documents, pending);
      const markdown = body?.replace(/\r\n/g, '\n') ?? existing?.body ?? templateBody(record, project, documents, this.sourceHref);
      if (type?.kind === 'entry' && markdown !== existing?.body) {
        const { issues } = readTrialLog(markdown);
        if (issues.length) {
          const prior = new Set(existing ? readTrialLog(existing.body).issues : []);
          const added = issues.find(issue => !prior.has(issue));
          if (added) throw new Error(added);
        }
      }
      const ruleBytes = captureFieldRules(record, existing, type, patch);
      if (existing && isDeepStrictEqual(existing.record, record) && existing.body === markdown) return existing;
      if ((ifRevision ?? null) !== (existing?.revision ?? null)) throw revisionConflict(change.id);
      const normalized = formatMarkdown(record, markdown);
      parseMarkdown(normalized, record.id);
      const encoded = existing?.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
      const bytes = Buffer.from((existing?.bom ? '\uFEFF' : '') + encoded);
      assert(bytes.length <= MAX_DOCUMENT_BYTES, 'The Markdown record exceeds 16 MB.');
      const directory = this.summaryPath && record.coverage ? SUMMARIES : RECORDS;
      const item = {
        record, body: markdown, bytes, ruleBytes, revision: digest(bytes), before: existing?.revision ?? null,
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

const comparisonTableGuide = '比较不同方案、轮次或条件下的数值时，优先用 Markdown 表格。标明比较对象，在表头写清指标和单位。正文解释差异对研究问题意味着什么，避免逐项复述表中数值。单个独立读数可以直接写在正文中。';
const reportWritingGuide = `实验记录和阶段总结采用“结论与关键图表前置、实验条件后置”的结构：1）开头用 1–3 句直接给出证据支持的结论和核心效果（涨/跌/持平及幅度），不要先铺垫背景、环境配置、脚本参数或前置条件；2）紧跟结论立刻放最能一眼看出效果的关键对比图、曲线和核心实测表格（${comparisonTableGuide}），引用可视化展示时放在首屏可直观查看的位置；3）多轮或跨日测量写在「实验试次」表；4）测量对象、相机/光照/分辨率、协议口径、审计回执与复现细节一律后置到「实验设置与适用范围」并链接原始证据，避免挤占首屏；5）缺少对照时先写本轮实测观察，把推测、待补对照和下一步验证放在文末「待验证」（无遗留时省略）。`;

const projectGuide = `# mekiR 研究项目的 Agent 指引

## 读取当前项目

${localSearchGuide}

${smartSearchGuide}

每批写入前先运行 \`node "<mekiR 源码目录>/electron/research-cli.cjs" describe "<项目根目录>"\`。读取 \`project.instructions\`，按 \`project.recordTypes\` 中的 ID 选择记录类型，再使用该类型的字段和模板。项目可以各自定义实验、分析、写作记录或总结。

在 \`fields\` 中使用字段 ID。按字段说明从实际产物取值，遵守类型、单位、范围与必填要求。枚举使用 \`options\` 中的原值。用正文说明缺失数据及原因。若必填项缺少有效值和可用默认值，先补证据。

## 这次工作是否归档，写进哪份实验

${filingSection}

## 写入记录

读取历史字段时，先核对 read 或 list 给出的 fieldOrigins。rule 是该值写入时采用的定义，source 为 record（明确写入）或 default（创建时采用项目默认值）。用 read.currentFields 对照当前定义。缺少来源时把历史口径记为未知。通过 batch 更新实际改变的字段，保留项目内 field-rules 快照和文稿中的引用。

1. 用 \`list\` 查找已有问题和试次，复用稳定记录 ID。用 \`read <目录> <ID>\` 获取已有的字段、正文和 \`revision\`。发生日期采用项目时区的实际日期。
2. 用 \`batch <目录> --input <文件或 ->\` 提交 \`ifProjectRevision\` 和 \`records\`。前者取自 \`describe.revision\`。新记录提交 \`id\`、\`ifRevision: null\`、\`type\`、\`title\`、\`date\` 及所需属性（按重要层级设置 \`tier\`: \`key\` / \`standard\` / \`log\`）。已有记录提交 \`id\`、\`read.revision\` 作为 \`ifRevision\`，以及要修改的内容。写入后检查返回的 \`warnings\`，若提示疑似重复试跑、工程故障或过度碎片化，应合并到母记录的「实验试次」表或调低层级。
3. 新建时，省略已配置默认值的字段会使用默认值，省略 \`body\` 会套用模板。更新时，省略的字段和正文保留原值。要主动清除可选字段，在 \`fields\` 中把该字段设为 \`null\`。收到 \`RESEARCH_CONFLICT\` 后重新读取规则和相关记录，再合并重试。

## 实验报告和阶段总结怎么写

${reportWritingGuide}

例如，开头写“开启遮挡剔除后，这条树林轨迹的 GPU 帧时间中位数为 11.4 ms。”文末「待验证」写“沿同一轨迹关闭遮挡剔除再测一次，比较两种设置的帧时间。”如果项目指定了结论字段，把首句写入该字段。写完用 \`list\` 核对 \`excerpt\` 是否准确传达本轮发现。

## 引用依据和撰写总结

图像对比的每一行对应同一机位，各列标明对应方法或轮次。登记相同宽高比的原图，将两份不同的证据 ID 写入同一行。实验记录或总结的 \`sources\` 引用这份对比的记录 ID 后，阅读侧栏可以直接拖动分界线查看。

用 \`list\` 的 \`documents\` 或 \`resolve <目录> <ID>\` 查找文档。用 \`index <目录> <ID> --path <相对路径>\` 登记普通文档，正文用 \`[标题](mekir:<ID>)\` 引用。外部目录用 \`bind-source\` 绑定，外部证据用 \`index --source <来源 ID>\` 登记。记录可用 \`evidence\` 保存证据 ID，并用 \`relations\` 保存 \`kind\`、\`target\` 和可选的 \`note\`。

总结的 \`type\` 取自本项目 \`kind\` 为 \`summary\` 的记录类型 ID。用 \`date\` 记撰写日期，用 \`coverage.start\` 和 \`coverage.end\` 记覆盖区间，首尾日期均计入。用 \`sources\` 引用依据，同一批次先写入新来源，再写总结。用 \`relatedProjects\` 保存其他项目的 ID，在总结的原项目更新同一条记录。

导入归档时用 \`import-archive\` 预览，核对新增、变化和缺件后提交返回的 token。导入信息保存在 \`run\` 中，项目字段可按现有规则用 \`batch\` 补录。用 \`list --query\`、\`--month\`、\`--field\` 或 \`--filter\` 查询相关记录。

阶段页先显示研究问题，再显示最近一次有结论的实验或总结。同日优先采用总结中的结论。实验和总结都可以通过类型的 conclusionField 指定结论字段，也可以直接在正文的「结论」小节写明。

## 修改字段、模板和视图

阶段可配置 \`description\` 和 \`goals: [{text, done?}]\`。项目的 \`phaseGoals\` 可设为 \`hidden\`、\`list\` 或 \`checklist\`，切换显示方式会保留已录入的目标。时间线截至项目时区的今天，起点由 \`project.start\` 指定，省略时从阶段和记录推断。

组会和审阅等事件使用 \`kind: "event"\` 的记录类型。用 \`describe.format.timeline.events.icons\` 查看可选图标。类型的 \`icon\` 保存图标 ID。用 \`batch\` 写入事件类型、实际发生日期、阶段 ID、字段和 Markdown 正文。

从 \`describe.project\` 复制配置，按任务需求修改 \`instructions\`、记录类型、字段、模板、阶段或视图。用 \`configure <目录> --input <文件或 ->\` 提交包含 \`ifRevision\` 和 \`project\` 的对象，\`ifRevision\` 取自 \`describe.revision\`。

在 \`phases\` 中填写必需的 \`start\`。结束日期未定时省略 \`end\` 或将其设为 \`null\`，确认结束后填入实际日期。阶段从开始日期起显示为进行中，固定结束日期当天仍计入。

图像对比用 \`describe.format.comparison\` 查询类型和网格规则。将阶段 ID 写入 \`phaseId\`，每格用已登记的原图证据 ID，图注写入 Markdown \`body\`。首次写入后使用返回的项目修订号。

调整显示名称时沿用原 ID。字段的含义或单位变化时使用新 ID，并同步更新模板里的 \`{{field.<ID>}}\` 和视图的 \`fieldIds\`。配置保存后重新 \`describe\`，用 \`list\` 的 \`issues\` 检查历史记录，再按需用 \`batch\` 补录。项目规则放在配置的 \`instructions\`，项目协作流程可在这份 \`AGENTS.md\` 中维护。
`;

module.exports = { ResearchStore, reportWritingGuide, comparisonTableGuide };

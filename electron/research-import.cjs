'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { decodeDocument, digest, readBytes } = require('./file-store.cjs');
const { evidencePath, knownEvidence } = require('./research-evidence.cjs');
const { assert, date, validateEvidencePath } = require('./research-model.cjs');

const archiveType = { id: 'archive-run', label: '归档实验', kind: 'entry', fields: [], template: '# {{title}}\n' };
const markerNames = ['RUN.md', 'run_manifest.json', 'manifest.json'];
const artifactFolders = ['figures', 'derived', 'raw', 'logs', 'captures'];
const datedDirectory = /^\d{4}[-_]?\d{2}[-_]?\d{2}(?:[-_. ]|$)/;
const markdownLink = /!?\[([^\]\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\r\n)]+))\)/g;
const MAX_RUNS = 4000;

const text = (value, limit = 2000) => {
  if (value === undefined || value === null) return '';
  const normalized = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return normalized.replace(/\0/g, '').trim().slice(0, limit);
};
const fileId = (sourceId, runId, file) => `evidence-${digest(Buffer.from(`${sourceId}\0${runId}\0${file}`)).slice(0, 24)}`;
const recordId = runId => `run-${digest(Buffer.from(runId)).slice(0, 24)}`;
const fileSuffix = file => knownEvidence.has(path.posix.extname(file).toLowerCase());

async function listDirectories(directory, relative = '', depth = 0) {
  const entries = (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (relative && (entries.some(entry => entry.isFile() && markerNames.includes(entry.name)) || datedDirectory.test(path.posix.basename(relative)))) {
    return [{ relative, entries }];
  }
  if (depth === 4) return [];
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || artifactFolders.includes(entry.name) || entry.name === 'node_modules') continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    runs.push(...await listDirectories(directory, next, depth + 1));
    assert(runs.length <= MAX_RUNS, 'Choose a smaller archive source to import at most 4000 runs at a time.');
  }
  return runs;
}

async function readInput(directory, relative, name) {
  const file = await evidencePath(directory, `${relative}/${name}`);
  const { bytes } = await readBytes(file.path, 8 * 1024 * 1024);
  return { content: decodeDocument(bytes).content, revision: digest(bytes) };
}

function reportValue(report, labels) {
  const expression = new RegExp(`^[ \\t]*[-*]?[ \\t]*(?:\\*\\*)?(?:${labels})(?:\\*\\*)?[ \\t]*[:：](?:\\*\\*)?[ \\t]*([^\\r\\n]+)`, 'im');
  return report.match(expression)?.[1]?.trim();
}

function reportSection(report, labels) {
  const expression = new RegExp(`^#{1,6}\\s+(?:${labels})\\s*\\n([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))`, 'im');
  return report.match(expression)?.[1]?.trim();
}

function extractContext(manifest, report) {
  const groups = [manifest, manifest.scope, manifest.settings, manifest.metadata, manifest.evaluation, manifest.inputs, manifest.protocol];
  const values = {
    question: ['question', 'research_question', 'objective', 'purpose', 'hypothesis'],
    models: ['models', 'model_names', 'model_scope', 'model', 'assets'],
    scene: ['scene', 'scenes', 'scene_name', 'environment'],
    method: ['method', 'methods', 'algorithm', 'representation'],
    camera: ['camera', 'camera_settings', 'camera_paths', 'camera_path', 'views', 'camera_protocol'],
    protocol: ['protocol', 'evaluation_protocol', 'evaluation', 'metrics', 'benchmark', 'parameters'],
    paper_version: ['paper_version', 'manuscript', 'paper_commit'],
    conclusion: ['conclusion', 'result_summary', 'decision', 'validation'],
  };
  const headings = {
    question: 'Question and protocol|Question|Objective|目的|研究问题|实验问题',
    models: 'Models?|Model scope|模型|模型范围|Inputs|输入',
    scene: 'Scenes?|场景', method: 'Methods?|方法',
    camera: 'Camera(?: settings| paths?)?|Cameras|相机|镜头',
    protocol: 'Protocol|Evaluation(?: protocol)?|Question and protocol|评测口径|评测协议|实验设置',
    paper_version: 'Paper version|Manuscript version|论文版本', conclusion: 'Conclusion|结论|结果',
  };
  return Object.fromEntries(Object.entries(values).flatMap(([field, keys]) => {
    const configured = groups.flatMap(group => keys.map(key => group?.[key])).find(value => text(value));
    const extracted = text(configured ?? (reportValue(report, headings[field]) || reportSection(report, headings[field])));
    return extracted ? [[field, extracted]] : [];
  }));
}

function runDate(values) {
  for (const value of values) {
    const match = /^(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?!\d)/.exec(text(value));
    if (!match) continue;
    const day = match.slice(1, 4).join('-');
    try { date(day, 'archive date'); return day; } catch { /* Try the next source of the run date. */ }
  }
}

async function readRun(directory, { relative, entries }) {
  const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
  const missing = [];
  const errors = [];
  const manifestName = markerNames.slice(1).find(name => files.has(name));
  const load = async (name, fallback) => {
    if (name && files.has(name)) {
      try { return await readInput(directory, relative, name); }
      catch (error) { errors.push(`${name}: ${error.message}`); }
    }
    missing.push(name || fallback);
    return null;
  };
  const reportInput = await load('RUN.md');
  if (reportInput && !reportInput.content.trim()) missing.push('RUN.md');
  const manifestInput = await load(manifestName, 'run_manifest.json');
  let manifest = {};
  if (manifestInput) {
    try {
      const parsed = JSON.parse(manifestInput.content);
      assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Expected a manifest object.');
      manifest = parsed;
    } catch (error) { errors.push(`${manifestName}: ${error.message}`); missing.push(manifestName); }
  }
  const report = reportInput?.content || '';
  const folder = path.posix.basename(relative);
  const runId = text(manifest.run_id ?? manifest.runId ?? reportValue(report, 'Run ID|实验 ID|运行 ID') ?? manifest.id, 240) || folder;
  const heading = report.match(/^#[ \t]+([^\n]+)$/m)?.[1];
  const title = (text(manifest.title ?? (/^(Experiment run|实验运行)$/i.test(heading || '') ? '' : heading), 240) || runId).replace(/[\r\n]+/g, ' ');
  const date = runDate([manifest.date, manifest.run_date, manifest.created_at, manifest.created, manifest.started_at,
    reportValue(report, 'Created|Date|记录日期|实验日期|创建日期'), runId, folder]);
  const parent = path.posix.basename(path.posix.dirname(relative));
  const category = text(manifest.category ?? manifest.type ?? reportValue(report, 'Type|类型'), 240) || (parent === '.' ? 'legacy_archive' : parent);
  const status = text(manifest.status ?? reportValue(report, 'Status|状态'), 240);
  const run = { id: runId, directory: relative, category, ...(status ? { status } : {}), context: extractContext(manifest, report), missing, evidence: [],
    ...(reportInput ? { reportRevision: reportInput.revision } : {}), ...(manifestInput ? { manifestRevision: manifestInput.revision } : {}) };
  return { run, title, date, errors, entries, report, manifest };
}

const linkPath = (bracketed, plain) => bracketed || plain.trim().replace(/\s+"[^"]*"$/, '');

function reportedPaths(report, manifest) {
  const links = [...report.matchAll(markdownLink)].map(match => linkPath(match[2], match[3]));
  const visit = (value, depth = 0) => {
    if (links.length >= 128 || value == null || depth > 20) return;
    if (typeof value === 'string') { if (fileSuffix(value)) links.push(value); }
    else if (typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1);
  };
  for (const key of ['files', 'evidence', 'artifacts', 'outputs', 'figures', 'reports', 'manifest_files']) visit(manifest[key]);
  return links.slice(0, 128);
}

function relativeArtifact(value, directory) {
  let file;
  try { file = decodeURIComponent(value.split('#', 1)[0]).replace(/\\/g, '/'); }
  catch { return null; }
  if (/^[a-z]:\/|^\//i.test(file)) {
    const location = file.toLowerCase().lastIndexOf(`/${directory.toLowerCase()}/`);
    if (location === -1) return null;
    file = file.slice(location + directory.length + 2);
  }
  if (!fileSuffix(file)) return null;
  try { return validateEvidencePath(file.replace(/^\.\//, '')); } catch { return null; }
}

async function artifacts(directory, candidate, sourceId) {
  const { run, entries, report, manifest } = candidate;
  const found = new Map();
  const add = async (file, required = false) => {
    if (found.has(file) || found.size >= 100) return;
    try {
      const relativePath = `${run.directory}/${file}`;
      await evidencePath(directory, relativePath);
      found.set(file, { sourceId, relativePath, title: path.posix.basename(file).slice(0, 240) });
    } catch { if (required && run.missing.length < 100 && !run.missing.includes(file)) run.missing.push(file); }
  };
  for (const name of markerNames) if (entries.some(entry => entry.isFile() && entry.name === name)) await add(name);
  const explicit = new Set(reportedPaths(report, manifest).map(value => relativeArtifact(value, run.directory)).filter(Boolean));
  for (const file of explicit) await add(file, true);
  const supplement = async (items, folder = '', depth = 0) => {
    for (const entry of items) {
      if (found.size >= 64) break;
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isFile() && fileSuffix(entry.name)) await add(relative);
      if (depth < 2 && entry.isDirectory() && !entry.name.startsWith('.') && (depth > 0 || artifactFolders.includes(entry.name))) {
        const children = await fs.readdir(path.join(directory, run.directory, relative), { withFileTypes: true });
        await supplement(children.sort((a, b) => a.name.localeCompare(b.name, 'en')), relative, depth + 1);
      }
    }
  };
  await supplement(entries);
  return [...found].map(([file, reference]) => [fileId(sourceId, run.id, file), reference]);
}

function importBody(candidate, files) {
  const { run, report, title } = candidate;
  if (!report.trim()) return `# ${title}\n`;
  const ids = new Map(files.map(([id, reference]) => [reference.relativePath.slice(run.directory.length + 1), id]));
  return report.replace(markdownLink, (original, label, bracketed, plain) => {
    const id = ids.get(relativeArtifact(linkPath(bracketed, plain), run.directory));
    return id ? `[${label}](mekir:${id})` : original;
  });
}

async function planArchive({ directory, sourceId, current, items, index, problems }) {
  const candidates = [];
  for (const found of await listDirectories(directory)) candidates.push(await readRun(directory, found));
  const occurrences = new Map();
  for (const { run } of candidates) occurrences.set(run.id, (occurrences.get(run.id) || 0) + 1);
  const byRun = new Map(), placeholders = new Map();
  const unreadable = new Set(problems.map(({ file }) => path.parse(file).name.slice(2)));
  for (const item of items.values()) {
    const run = item.record.run;
    if (run?.sourceId === sourceId && run.id === path.posix.basename(run.directory) && run.missing.includes('RUN.md')) {
      placeholders.set(run.directory, item);
    }
    const identity = item.record.run?.id || item.record.fields.run_id;
    if (typeof identity !== 'string') continue;
    const matches = byRun.get(identity) || [];
    matches.push(item);
    byRun.set(identity, matches);
  }
  const runs = [], changes = [], references = new Map(), bodies = new Map();
  const claimedRecords = new Set();
  const existingType = current.project.recordTypes.find(type => type.id === archiveType.id);
  for (const candidate of candidates) {
    const { run, title, date, errors } = candidate;
    const item = { runId: run.id, title, directory: run.directory, missing: run.missing };
    const matches = byRun.get(run.id) || [];
    const placeholder = placeholders.get(run.directory);
    const byId = matches[0] || items.get(recordId(run.id)) || items.get(run.id);
    const existing = byId || placeholder;
    const id = existing?.record.id || recordId(run.id);
    let blocker = '';
    if (occurrences.get(run.id) > 1 || matches.length > 1 || claimedRecords.has(id) || (byId && placeholder && byId !== placeholder) || (byId?.record.run && byId.record.run.id !== run.id)) {
      blocker = 'More than one source run or project record uses this run ID.';
    } else if (unreadable.has(id) || index.paths.has(id) || index.evidence.has(id)) {
      blocker = 'The target record ID is occupied or unreadable.';
    } else if (!existing && !date) {
      blocker = 'No run date could be read from the manifest, report, or directory name.';
    } else if (!existing && existingType && (existingType.kind !== 'entry' || existingType.fields.some(field => field.required && field.default === undefined))) {
      blocker = 'The archive-run type requires fields the import cannot populate.';
    }
    if (blocker) { runs.push({ ...item, error: [...errors, blocker].join(' '), change: 'blocked' }); continue; }
    if (errors.length) item.error = errors.join(' ');
    claimedRecords.add(id);
    const files = await artifacts(directory, candidate, sourceId);
    const body = importBody(candidate, files);
    run.sourceId = sourceId;
    run.title = title;
    if (date) run.date = date;
    run.evidence = files.map(([id]) => id);
    run.importedBodyRevision = digest(Buffer.from(body));
    for (const [file, reference] of files) {
      assert(!items.has(file) && !index.paths.has(file), `An evidence ID is already used by a project document: ${file}.`);
      references.set(file, reference);
    }
    const changed = !existing || !isDeepStrictEqual(existing.record.run, run)
      || files.some(([id, reference]) => !isDeepStrictEqual(index.evidence.get(id), reference));
    const change = !existing ? 'new' : changed ? 'changed' : 'unchanged';
    runs.push({ ...item, change });
    if (!changed) continue;
    bodies.set(id, body);
    const old = existing?.record.run;
    changes.push(existing ? { id, ifRevision: existing.revision, run,
      ...(old?.title === existing.record.title ? { title } : {}),
      ...(date && old?.date === existing.record.date ? { date } : {}) }
      : { id, ifRevision: null, type: archiveType.id, title, date, run });
  }
  const token = digest(Buffer.from(JSON.stringify([directory, sourceId, current.revision, index.revision, runs, changes, [...references]])));
  return { preview: { sourceId, token, runs }, changes, references, bodies, proposed: !existingType && changes.some(change => change.type === archiveType.id)
    ? { ...current.project, recordTypes: [...current.project.recordTypes, archiveType] } : current.project };
}

module.exports = { planArchive, MAX_RUNS };

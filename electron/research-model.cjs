'use strict';

const { isDeepStrictEqual } = require('node:util');
const { DOCUMENT_SCHEME, RESEARCH_ID } = require('./research-links.mjs');

const METADATA = '.mekir';
const MANIFEST = `${METADATA}/project.json`;
const LEGACY_MANIFEST = 'meki-project.json';
const INDEX = `${METADATA}/index.json`;
const SUMMARIES = `${METADATA}/summaries`;
const RECORDS = 'records';
const RECORD_FILE = /^r-([a-z][a-z0-9_-]{0,63})\.md$/;
const REVISION = /^[a-f0-9]{64}$/;
const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'choice'];
const TEMPLATE_KEYS = ['title', 'date', 'phase', 'coverage_start', 'coverage_end', 'sources'];
const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  if (keys) for (const key of Object.keys(value)) assert(keys.includes(key), `${label} has an unknown property: ${key}.`);
}

function string(value, label, { limit = 240, empty = false } = {}) {
  assert(typeof value === 'string' && (empty || value.trim()) && value.length <= limit && !value.includes('\0'), `${label} must be text (up to ${limit} characters).`);
}

function id(value, label) {
  assert(typeof value === 'string' && RESEARCH_ID.test(value), `${label} must be a lowercase identifier such as render-a.`);
}

function date(value, label) {
  assert(isDate(value), `${label} must be a real calendar date in YYYY-MM-DD format.`);
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

function range(start, end, label) {
  date(start, `${label}.start`);
  date(end, `${label}.end`);
  assert(start <= end, `${label}.end must be on or after its start.`);
}

function array(value, label, max) {
  assert(Array.isArray(value) && value.length <= max, `${label} must be an array with at most ${max} items.`);
}

function unique(values, label) {
  assert(new Set(values).size === values.length, `${label} contains duplicates.`);
}

function listOfIds(value, label, max = 100) {
  array(value, label, max);
  value.forEach(item => id(item, label));
  unique(value, label);
}

function fieldError(rule, value) {
  switch (rule.type) {
    case 'text': return typeof value !== 'string' || !value.trim() || value.length > 1000 || value.includes('\0') ? 'must be nonempty text (up to 1000 characters)' : null;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (rule.min !== undefined && value < rule.min) return `must be at least ${rule.min}`;
      if (rule.max !== undefined && value > rule.max) return `must be at most ${rule.max}`;
      return null;
    }
    case 'boolean': return typeof value !== 'boolean' ? 'must be true or false' : null;
    case 'date': return !isDate(value) ? 'must be a real calendar date (YYYY-MM-DD)' : null;
    case 'choice': return !rule.options.includes(value) ? `must be one of: ${rule.options.join(', ')}` : null;
    default: return 'has an unsupported type';
  }
}

function validateField(rule, typeId) {
  object(rule, 'field', ['id', 'label', 'type', 'description', 'required', 'unit', 'min', 'max', 'options', 'default']);
  const label = `recordTypes.${typeId}.fields.${rule.id}`;
  id(rule.id, label);
  string(rule.label, `${label}.label`);
  assert(FIELD_TYPES.includes(rule.type), `${label}.type must be one of: ${FIELD_TYPES.join(', ')}.`);
  if (rule.description !== undefined) string(rule.description, `${label}.description`, { limit: 1000 });
  if (rule.required !== undefined) assert(typeof rule.required === 'boolean', `${label}.required must be a boolean.`);
  if (rule.unit !== undefined) string(rule.unit, `${label}.unit`, { limit: 32 });
  for (const key of ['min', 'max']) {
    if (rule[key] !== undefined) assert(rule.type === 'number' && Number.isFinite(rule[key]), `${label}.${key} requires a numeric field and a finite bound.`);
  }
  if (rule.min !== undefined && rule.max !== undefined) assert(rule.min <= rule.max, `${label}.min must be at most max.`);
  if (rule.type === 'choice') {
    array(rule.options, `${label}.options`, 40);
    assert(rule.options.length > 0, `${label}.options must contain at least one choice.`);
    rule.options.forEach(option => string(option, `${label}.options`, { limit: 100 }));
    unique(rule.options, `${label}.options`);
  } else assert(rule.options === undefined, `${label}.options requires a choice field.`);
  if (rule.default !== undefined) {
    const error = fieldError(rule, rule.default);
    assert(!error, `${label}.default ${error}.`);
  }
}

function validateProject(project) {
  object(project, 'project', ['version', 'id', 'title', 'description', 'timezone', 'instructions', 'phases', 'recordTypes', 'views', 'defaultView']);
  assert(project.version === 1, 'project.version must be 1.');
  id(project.id, 'project.id');
  string(project.title, 'project.title');
  if (project.description !== undefined) string(project.description, 'project.description', { limit: 2000 });
  string(project.timezone, 'project.timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: project.timezone }); }
  catch { throw new Error('project.timezone must be a valid time zone such as Asia/Shanghai.'); }
  if (project.instructions !== undefined) {
    array(project.instructions, 'project.instructions', 24);
    project.instructions.forEach(item => string(item, 'project.instructions', { limit: 2000 }));
  }
  array(project.phases, 'project.phases', 64);
  for (const phase of project.phases) {
    object(phase, 'phase', ['id', 'title', 'start', 'end']);
    id(phase.id, 'phase.id');
    string(phase.title, `phases.${phase.id}.title`);
    range(phase.start, phase.end, `phases.${phase.id}`);
  }
  unique(project.phases.map(phase => phase.id), 'project.phases');

  array(project.recordTypes, 'project.recordTypes', 24);
  assert(project.recordTypes.length > 0, 'Define at least one record type.');
  for (const type of project.recordTypes) {
    object(type, 'record type', ['id', 'label', 'kind', 'description', 'fields', 'template']);
    id(type.id, 'record type.id');
    string(type.label, `recordTypes.${type.id}.label`);
    assert(['entry', 'summary'].includes(type.kind), `recordTypes.${type.id}.kind must be entry or summary.`);
    if (type.description !== undefined) string(type.description, `recordTypes.${type.id}.description`, { limit: 1000 });
    array(type.fields, `recordTypes.${type.id}.fields`, 32);
    type.fields.forEach(rule => validateField(rule, type.id));
    unique(type.fields.map(rule => rule.id), `recordTypes.${type.id}.fields`);
    string(type.template, `recordTypes.${type.id}.template`, { limit: 16000, empty: true });
    const keys = new Set([...TEMPLATE_KEYS, ...type.fields.map(rule => `field.${rule.id}`)]);
    for (const [, key] of type.template.matchAll(TOKEN)) assert(keys.has(key), `Unknown template value {{${key}}} in ${type.id}.`);
  }
  unique(project.recordTypes.map(type => type.id), 'project.recordTypes');

  array(project.views, 'project.views', 24);
  for (const view of project.views) {
    object(view, 'view', ['id', 'label', 'layout', 'order', 'typeIds', 'phaseIds', 'fieldIds']);
    id(view.id, 'view.id');
    string(view.label, `views.${view.id}.label`);
    assert(['timeline', 'journal'].includes(view.layout), `views.${view.id}.layout must be timeline or journal.`);
    assert(['newest', 'oldest'].includes(view.order), `views.${view.id}.order must be newest or oldest.`);
    if (view.typeIds !== undefined) {
      listOfIds(view.typeIds, `views.${view.id}.typeIds`, 24);
      assert(view.typeIds.length && view.typeIds.every(key => project.recordTypes.some(type => type.id === key)), `views.${view.id}.typeIds must name existing record types.`);
    }
    if (view.phaseIds !== undefined) {
      listOfIds(view.phaseIds, `views.${view.id}.phaseIds`, 64);
      assert(view.phaseIds.length && view.phaseIds.every(key => project.phases.some(phase => phase.id === key)), `views.${view.id}.phaseIds must name existing phases.`);
    }
    if (view.fieldIds !== undefined) {
      listOfIds(view.fieldIds, `views.${view.id}.fieldIds`, 32);
      const types = project.recordTypes.filter(type => !view.typeIds || view.typeIds.includes(type.id));
      assert(view.fieldIds.every(key => types.some(type => type.fields.some(rule => rule.id === key))), `views.${view.id}.fieldIds must name fields in this view's record types.`);
    }
  }
  unique(project.views.map(view => view.id), 'project.views');
  assert(project.views.some(view => view.id === project.defaultView), 'project.defaultView must name a configured view.');
  return project;
}

function validateRecord(record, expectedId) {
  object(record, 'record', ['id', 'type', 'title', 'date', 'phaseId', 'coverage', 'sources', 'fields']);
  id(record.id, 'record.id');
  assert(record.id === expectedId, `record.id must match the filename r-${expectedId}.md.`);
  id(record.type, 'record.type');
  string(record.title, 'record.title');
  assert(!/[\r\n]/.test(record.title), 'record.title must be a single line.');
  date(record.date, 'record.date');
  if (record.phaseId != null) id(record.phaseId, 'record.phaseId');
  if (record.coverage != null) {
    object(record.coverage, 'record.coverage', ['start', 'end']);
    range(record.coverage.start, record.coverage.end, 'record.coverage');
  }
  if (record.sources !== undefined) {
    listOfIds(record.sources, 'record.sources');
    assert(!record.sources.includes(record.id), 'A record cannot cite itself.');
  }
  object(record.fields, 'record.fields');
  for (const [key, value] of Object.entries(record.fields)) {
    id(key, 'record.fields key');
    assert(typeof value === 'boolean' || Number.isFinite(value) || typeof value === 'string' && value.length <= 1000 && !value.includes('\0'), `record.fields.${key} must be scalar text, a number, or a boolean.`);
  }
  return record;
}

function relationshipIssues(record, project) {
  const type = project.recordTypes.find(item => item.id === record.type);
  const issues = [];
  if (!type) issues.push(`Unknown record type: ${record.type}.`);
  else if (type.kind === 'summary' && !record.coverage) issues.push('A summary needs a coverage start and end date.');
  else if (type.kind === 'entry' && record.coverage) issues.push('Coverage is only used by summary records.');
  if (record.phaseId && !project.phases.some(phase => phase.id === record.phaseId)) issues.push(`Unknown phase: ${record.phaseId}.`);
  return issues;
}

function fieldIssues(record, type) {
  if (!type) return [];
  const checks = [];
  for (const rule of type.fields) {
    const value = Object.hasOwn(record.fields, rule.id) ? record.fields[rule.id] : undefined;
    const error = value === undefined ? rule.required && 'is required' : fieldError(rule, value);
    if (error) checks.push({ field: rule.id, message: `${rule.label} (${rule.id}) ${error}.` });
  }
  for (const key of Object.keys(record.fields)) {
    if (!type.fields.some(rule => rule.id === key)) checks.push({ field: key, message: `${key} is no longer a configured field.` });
  }
  return checks;
}

function validateChange(record, previous, project, documents) {
  const issues = relationshipIssues(record, project);
  if (issues.length) throw new Error(issues.join(' '));
  for (const source of record.sources || []) {
    assert(documents.has(source) || previous?.sources?.includes(source), `Source document does not exist: ${source}.`);
  }
  const type = project.recordTypes.find(item => item.id === record.type);
  for (const { field, message } of fieldIssues(record, type)) {
    if (previous?.type === record.type && Object.hasOwn(previous.fields, field) === Object.hasOwn(record.fields, field)
      && isDeepStrictEqual(previous.fields[field], record.fields[field])) continue;
    throw new Error(message);
  }
}

function parseMarkdown(content, expectedId) {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(content);
  assert(match, 'A research record needs a JSON metadata block between two --- lines.');
  assert(match[1].length <= 64 * 1024, 'Research metadata exceeds 64 KiB.');
  let record;
  try { record = JSON.parse(match[1]); }
  catch { throw new Error('The research record metadata is not valid JSON.'); }
  return { record: validateRecord(record, expectedId), body: content.slice(match[0].length).replace(/^\n/, '') };
}

function formatMarkdown(record, body) {
  return `---\n${JSON.stringify(record, null, 2)}\n---\n\n${body}`;
}

function fileName(recordId) {
  id(recordId, 'record.id');
  return `r-${recordId}.md`;
}

function templateBody(record, project, documents, sourceHref) {
  const type = project.recordTypes.find(item => item.id === record.type);
  const title = value => value.replace(/[\\\[\]]/g, '\\$&');
  const values = {
    title: record.title, date: record.date, phase: project.phases.find(phase => phase.id === record.phaseId)?.title || '',
    coverage_start: record.coverage?.start || '', coverage_end: record.coverage?.end || '',
    sources: (record.sources || []).map(source => `- [${title(documents.get(source)?.title || source)}](${sourceHref(source)})`).join('\n'),
  };
  return type.template.replace(TOKEN, (_, key) => key.startsWith('field.')
    ? String(Object.hasOwn(record.fields, key.slice(6)) ? record.fields[key.slice(6)] : '')
    : values[key]);
}

module.exports = {
  METADATA, MANIFEST, LEGACY_MANIFEST, INDEX, SUMMARIES, RECORDS, DOCUMENT_SCHEME,
  RECORD_FILE, REVISION, FIELD_TYPES, TEMPLATE_KEYS,
  assert, object, array, id, date, listOfIds, validateProject, validateRecord, relationshipIssues,
  fieldIssues, validateChange, parseMarkdown, formatMarkdown, fileName, templateBody,
};

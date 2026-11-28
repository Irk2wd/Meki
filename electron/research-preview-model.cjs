'use strict';

const { digest } = require('./file-store.cjs');
const { isDate, REVISION, assert } = require('./research-model.cjs');
const { RESEARCH_ID } = require('./research-links.mjs');
const { activityDates, latestActivity, projectToday, summaryCoversPhase } = require('./research-phases.mjs');
const icons = require('./research-event-icons.json');

const maxSnapshot = 8 * 1024 * 1024;
const maxThumbnail = 2 * 1024 * 1024;
const maxMediaBytes = 128 * 1024 * 1024;
const maxBody = 96 * 1024;
const maxPinned = 24;
const version = 'mekir-preview/1';
const pngHeader = Buffer.from([137,80,78,71,13,10,26,10]);
function imageFormat(bytes) {
  if (bytes.subarray(0,8).equals(pngHeader)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  throw Error('无法识别缩略图格式。');
}
const mediaName = (snapshot,hash) => hash + (snapshot.mediaTypes?.[hash] === 'jpeg' ? '.jpg' : '.png');
const validId = value => typeof value === 'string' && RESEARCH_ID.test(value);
const validHash = value => typeof value === 'string' && REVISION.test(value);
const strings = (values, check) => Array.isArray(values) && values.every(check);
const text = value => typeof value === 'string';
const count = n => Number.isSafeInteger(n) && n >= 0;

function validatePointer(p) {
  assert(p?.format === version && validId(p.projectId) && validHash(p.revision) && (!p.previous || validHash(p.previous))
    && typeof p.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.publishedAt) && Number.isFinite(Date.parse(p.publishedAt)), 'Invalid remote preview version.');
  return p;
}

function validateSnapshot(s, projectId) {
  assert(s?.format === version && s.project?.id === projectId && validId(projectId) && text(s.project.title)
    && text(s.project.description) && isDate(s.asOf) && ['hidden','list','checklist'].includes(s.project.phaseGoals)
    && (!s.project.start || isDate(s.project.start)) && Array.isArray(s.phases) && Array.isArray(s.items), 'Invalid project preview.');
  assert(!s.mediaTypes || (typeof s.mediaTypes === 'object' && !Array.isArray(s.mediaTypes) &&
    Object.entries(s.mediaTypes).every(([hash,mime]) => validHash(hash) && mime === 'jpeg')), 'Invalid preview media types.');
  const { timezone, types, views, defaultView } = s.project;
  if (timezone !== undefined) {
    assert(text(timezone) && timezone.length <= 100, 'Invalid preview timezone.');
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  }
  assert(types === undefined || strings(types, t => t && validId(t.id) && text(t.label) &&
    ['entry','event','summary','comparison'].includes(t.kind) && (!t.icon || Object.hasOwn(icons, t.icon))), 'Invalid preview record types.');
  assert(views === undefined || strings(views, v => v && validId(v.id) && text(v.label) &&
    ['timeline','journal'].includes(v.layout) && ['oldest','newest'].includes(v.order) &&
    [v.phaseIds,v.typeIds].every(list => list === undefined || strings(list,validId)) &&
    (v.tiers === undefined || strings(v.tiers,tier => ['key','standard','log'].includes(tier)))), 'Invalid preview views.');
  assert(defaultView === undefined || validId(defaultView), 'Invalid default preview view.');
  const ids = new Set();
  for (const p of s.phases) {
    assert(p && (validId(p.id) || p.id === '') && !ids.has(p.id) && text(p.title) && text(p.description)
      && isDate(p.start) && (!p.end || isDate(p.end)) && (!p.latest || isDate(p.latest)) && count(p.records) && (!p.finding || (text(p.finding.text) && isDate(p.finding.date)))
      && Array.isArray(p.days) && p.days.every(d => d && isDate(d.date) && count(d.records) && count(d.trials))
      && Array.isArray(p.goals) && p.goals.every(g => g && text(g.text) && (g.done === undefined || typeof g.done === 'boolean')), 'Invalid preview phase.');
    ids.add(p.id);
  }
  const itemIds = new Set();
  for (const i of s.items) {
    assert(i && validId(i.id) && !itemIds.has(i.id) && text(i.title) && text(i.label) && text(i.text) && isDate(i.date)
      && (i.type === undefined || validId(i.type))
      && (i.days === undefined || strings(i.days,isDate)) && (i.sources === undefined || strings(i.sources,validId))
      && (i.tier === undefined || ['key','standard','log'].includes(i.tier))
      && strings(i.phases, p => ids.has(p)) && (i.phaseId === undefined || i.phases.includes(i.phaseId)) && ['entry','event','comparison','summary'].includes(i.kind)
      && (!i.icon || Object.hasOwn(icons, i.icon)) && (i.body === undefined || (text(i.body) && Buffer.byteLength(i.body) <= maxBody))
      && (!i.coverage || (isDate(i.coverage.start) && isDate(i.coverage.end))), 'Invalid preview item.');
    itemIds.add(i.id);
    if (!i.figure) continue;
    assert(strings(i.figure.columns, text) && i.figure.columns.length <= 8 && Array.isArray(i.figure.rows) && i.figure.rows.length <= 16
      && i.figure.rows.every(r => r && text(r.label) && Array.isArray(r.images) && r.images.length === i.figure.columns.length
        && r.images.every(h => h === null || validHash(h))), 'Invalid preview figure.');
  }
  return s;
}

function mediaHashes(snapshot) {
  const hashes = new Set();
  for (const item of snapshot.items) for (const row of item.figure?.rows || [])
    for (const hash of row.images) if (hash) hashes.add(hash);
  return hashes;
}

async function projectPreview(store, pinned, makeThumbnail) {
  const { project, records, comparisonType, problems } = await store.snapshot();
  if (problems.length) throw Error(`无法发布完整快照。${problems[0].file} · ${problems[0].message}`);
  const asOf = projectToday(project.timezone);
  const groups = new Map();
  for (const p of project.phases) groups.set(p.id, { id:p.id, title:p.title, description:p.description || '',
    start:p.start, end:p.end || null, goals:project.phaseGoals === 'hidden' ? [] : p.goals || [], records:0, activity:new Map() });
  const types = new Map([comparisonType, ...project.recordTypes].map(t => [t.id,t]));
  const replaced = new Set(records.flatMap(({record}) => (record.relations || []).filter(r => r.kind === 'replaces').map(r => r.target)));
  const items = [], media = new Map(), references = new Map(), mediaTypes = {};
  let mediaBytes = 0;
  async function thumbnail(id) {
    if (id === null) return null;
    if (!references.has(id)) {
      const bytes = await makeThumbnail(id);
      assert(bytes.length > 0 && bytes.length <= maxThumbnail, 'Thumbnail is too large.');
      const hash = digest(bytes);
      if (imageFormat(bytes) === 'jpeg') mediaTypes[hash] = 'jpeg';
      if (!media.has(hash)) mediaBytes += bytes.length;
      assert(mediaBytes <= maxMediaBytes, 'Preview images exceed the snapshot limit.');
      references.set(id, hash);
      media.set(hash, bytes);
    }
    return references.get(id);
  }
  for (const entry of records) {
    const { record:r, excerpt = '' } = entry, type = types.get(r.type);
    const kind = r.comparison ? 'comparison' : r.coverage ? 'summary' : type?.kind || 'entry';
    const assigned = kind === 'summary' ? project.phases.filter(p => summaryCoversPhase(r, p, project.phases, asOf)).map(p => p.id) : [];
    if (!assigned.length) assigned.push(groups.has(r.phaseId) ? r.phaseId : '');
    if (assigned.includes('') && !groups.has('')) groups.set('', { id:'', title:'', description:'', start:r.date, end:null, goals:[], records:0, activity:new Map() });
    for (const id of assigned) {
      const g = groups.get(id);
      if (!id && r.date < g.start) g.start = r.date;
      if (kind === 'entry') {
        g.records++;
        for (const date of activityDates(entry)) {
          if (!g.activity.has(date)) g.activity.set(date, {date, records:0, trials:0});
          g.activity.get(date).records++;
        }
        for (const trial of entry.trials || []) g.activity.get(trial.date).trials++;
      }
      const date = latestActivity(entry, '', asOf);
      if (date && date > (g.latest || '')) g.latest = date;
      const invalid = [r.fields?.outcome, r.fields?.status, r.run?.status].some(v => /^(invalid|无效|cancelled|canceled|aborted|已取消|已中止)$/i.test(String(v).trim()));
      if (date && excerpt && (kind === 'summary' || (kind === 'entry' && r.tier !== 'log' && !replaced.has(r.id) && !invalid))) {
        const rank = `${date}/${kind === 'summary' ? 2 : r.tier === 'key' ? 1 : 0}/${r.id}`;
        if (!g.rank || rank > g.rank) { g.finding = {date,text:excerpt}; g.rank = rank; }
      }
    }
    if (kind === 'entry' && !pinned.includes(r.id)) continue;
    const item = { id:r.id, type:r.type, phaseId:assigned.includes(r.phaseId) ? r.phaseId : assigned[0], tier:r.tier, phases:assigned, title:r.title, date:r.date, kind, label:type?.label || r.type, icon:type?.icon, text:excerpt };
    if (entry.trials?.length) item.days = [...new Set(entry.trials.map(trial => trial.date))];
    if (r.sources?.length) item.sources = r.sources;
    if (r.coverage) item.coverage = r.coverage;
    if (pinned.includes(r.id)) {
      item.body = (await store.read(r.id)).body;
      assert(Buffer.byteLength(item.body) <= maxBody, `“${r.title}”超过精选正文大小限制。`);
    }
    if (r.comparison) {
      const rows = [];
      for (const row of r.comparison.rows) {
        const images = [];
        for (const id of row.images) images.push(await thumbnail(id));
        rows.push({label:row.label,images});
      }
      item.figure = {columns:r.comparison.columns, rows};
      item.text = (await store.read(r.id)).body.trim().slice(0, 2000);
    }
    items.push(item);
  }
  const sharedIds = new Set(items.map(item => item.id));
  for (const item of items) if (item.sources) item.sources = item.sources.filter(id => sharedIds.has(id));
  const publicTypes = [...types.values()].map(({id,label,kind,icon}) => ({id,label:label || id,kind,icon}));
  const views = (project.views || []).map(({id,label,layout,order,phaseIds,typeIds,tiers}) => ({id,label,layout,order,phaseIds,typeIds,tiers}));
  const snapshot = { format:version, asOf, project:{id:project.id, title:project.title, description:project.description || '',
    timezone:project.timezone, types:publicTypes, views, defaultView:project.defaultView, start:project.start, phaseGoals:project.phaseGoals || 'list'}, phases:[...groups.values()].map(({activity,rank,...phase}) =>
    ({...phase,days:[...activity.values()].sort((a,b) => a.date.localeCompare(b.date))})), items:items.sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)) };
  if (Object.keys(mediaTypes).length) snapshot.mediaTypes = mediaTypes;
  // Validate the wire representation; omitted fields on disk must work the same as local values.
  const bytes = Buffer.from(JSON.stringify(snapshot));
  assert(bytes.length <= maxSnapshot, 'Project preview exceeds 8 MiB.');
  validateSnapshot(JSON.parse(bytes), project.id);
  return {snapshot, bytes, revision:digest(bytes), media, timezone:project.timezone};
}

module.exports = {version, maxSnapshot, maxThumbnail, maxMediaBytes, maxPinned, validId, validHash, imageFormat, mediaName, mediaHashes, validatePointer, validateSnapshot, projectPreview};

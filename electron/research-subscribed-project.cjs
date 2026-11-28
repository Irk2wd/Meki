'use strict';

const { researchMatcher } = require('./research-filter.cjs');
const { validateFilter } = require('./research-model.cjs');
const { digest } = require('./file-store.cjs');
const { t } = require('./i18n.mjs');

const prefix = 'subscription:';
const isSubscribedRoot = root => typeof root === 'string' && root.startsWith(prefix);

async function subscribedProject(service, root) {
  const id = root.slice(prefix.length);
  const state = await service.cached(id);
  if (!state) throw Error(t("本机还没有这项订阅的快照，请刷新项目。"));
  return projectFromSnapshot(root, state, hash => service.image(id, hash));
}

// Only published documents and content-addressed thumbnails have a read capability.
function projectFromSnapshot(root, preview, loadImage) {
  const { pointer, snapshot } = preview;
  const { project: info, items } = snapshot;
  let unassigned = 'unassigned';
  while (snapshot.phases.some(p => p.id === unassigned)) unassigned += '_';
  const phaseId = id => id || unassigned;
  const phases = snapshot.phases.map(p => ({ ...p, id: phaseId(p.id), title: p.title || t("未分阶段") }));
  const types = new Map((info.types || []).map(type => [type.id, { ...type, fields: [], template: '' }]));
  const legacyTypes = new Map();
  const documents = [], records = [], bodies = new Map(), images = new Map();
  const publishedIds = new Set(items.map(item => item.id));
  for (const item of items) {
    let type = types.get(item.type);
    if (!type || type.kind !== item.kind) {
      const key = JSON.stringify([item.kind, item.label, item.icon]);
      type = legacyTypes.get(key);
      if (!type) {
        let id = 'shared-' + digest(Buffer.from(key)).slice(0, 16);
        while (types.has(id)) id += '_';
        type = { id, label: item.label, kind: item.kind, icon: item.icon, fields: [], template: '' };
        types.set(id, type);
        legacyTypes.set(key, type);
      }
    }
    const record = { id: item.id, type: type.id, title: item.title, date: item.date,
      tier: item.tier, phaseId: phaseId(item.phaseId ?? item.phases[0]), coverage: item.coverage, fields: {},
      sources: item.sources?.filter(id => publishedIds.has(id)) };
    if (item.figure) {
      record.comparison = item.figure;
      for (const row of item.figure.rows) row.images.forEach((hash, column) => {
        if (hash && !images.has(hash)) images.set(hash, row.label + ' · ' + item.figure.columns[column]);
      });
    }
    const relativePath = item.id + '.md';
    const body = item.body ?? item.text;
    const revision = digest(Buffer.from(JSON.stringify(item)));
    const entry = { record, excerpt: item.text, revision, relativePath, issues: [],
      trials: item.days?.map(date => ({ id: date, date })) };
    records.push(entry);
    documents.push({ id: item.id, title: item.title, date: item.date, relativePath });
    bodies.set(item.id, { ...entry, body, excerptOnly: item.body === undefined && item.kind !== 'comparison' });
  }
  const knownTypes = [...types.values()];
  const project = { version: 1, id: info.id, title: info.title, description: info.description, start: info.start,
    timezone: info.timezone || 'UTC', phaseGoals: info.phaseGoals, phases, recordTypes: knownTypes,
    views: info.views || [], defaultView: info.defaultView || '' };
  const comparisonType = knownTypes.find(type => type.kind === 'comparison') ||
    { id: 'comparison', label: t("可视化展示"), kind: 'comparison', fields: [], template: '' };
  return {
    root, preview,
    manifest() { return { project }; },
    snapshot(filter) {
      const match = filter && researchMatcher(validateFilter(filter), project);
      return { root, project, comparisonType, revision: pointer.revision, manifestFile: '', records, documents, problems: [],
        ...(match && { matchingIds: [...bodies.values()].filter(match).map(doc => doc.record.id) }),
        subscription: { publishedAt: pointer.publishedAt, asOf: snapshot.asOf,
          phases: Object.fromEntries(phases.map(p => [p.id, {records:p.records, latest:p.latest, finding:p.finding, days:p.days}])),
          summaryPhases: Object.fromEntries(items.filter(i => i.kind === 'summary').map(i => [i.id, i.phases.map(phaseId)])) } };
    },
    read(id) {
      if (!bodies.has(id)) throw Error(t("这份资料未包含在共享快照中。"));
      return bodies.get(id);
    },
    async image(hash) {
      if (!images.has(hash)) throw Error(t("这张图片未包含在共享快照中。"));
      const url = await loadImage(hash);
      if (!url) throw Error(t("缩略图暂不可用，请刷新项目。"));
      return { id: hash, title: images.get(hash), source: t("共享快照"), relativePath: images.get(hash),
        kind: 'image', mime: url.slice(5, url.indexOf(';')), content: url.slice(url.indexOf(',') + 1) };
    },
  };
}
module.exports = { isSubscribedRoot, projectFromSnapshot, subscribedProject };

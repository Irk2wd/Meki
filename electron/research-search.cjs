'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { digest, pathKey, readBytes, decodeDocument, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');
const { assert, isDate, object } = require('./research-model.cjs');
const { activityDates } = require('./research-phases.mjs');
const { comparisonImages } = require('./research-comparison.mjs');
const { markdownPassages, reportPassages } = require('./research-search-passages.cjs');
const { embed, modelId, searchHome } = require('./research-search-model.cjs');

const hash = text => digest(Buffer.from(text));
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stop = new Set('的 了 在 有 和 这 是 还 能 吗 哪 哪一 个 哪个 从 我 想 找 怎么 是否 a an the of to in is'.split(' '));
const normalize = s => s.normalize('NFKC').toLowerCase();
function tokens(value) {
  const s = normalize(value);
  const words = Array.from(segmenter.segment(s), item => item.isWordLike && item.segment).filter(word => word && !stop.has(word));
  for (const group of s.match(/\p{Script=Han}{2,}/gu) || []) {
    const chars = [...group];
    for (let i = 1; i < chars.length; i++) words.push(chars[i - 1] + chars[i]);
  }
  words.push(...s.match(/[a-z0-9]+(?:[_./-][a-z0-9]+)+/g) || []);
  return words;
}
function options(input) {
  object(input, 'search', ['query', 'mode', 'format', 'from', 'to', 'phase', 'limit']);
  assert(typeof input.query === 'string' && input.query.trim() && input.query.length <= 500, 'Provide a search query (1–500 characters).');
  const { query, mode = 'keyword', format = 'all', from, to, phase, limit = 12 } = input;
  assert(['keyword','concept'].includes(mode) && ['all','markdown','pdf','pptx','file'].includes(format), 'Unknown search mode or format.');
  assert((from === undefined || isDate(from)) && (to === undefined || isDate(to)) && (!from || !to || from <= to), 'Invalid search date range.');
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Search limit must be between 1 and 100.');
  return { query: query.trim(), mode, format, from, to, phase, limit };
}
function formatOf(name) {
  if (/\.(?:md|markdown|mdown|mkd|mkdn|txt)$/i.test(name)) return 'markdown';
  return /\.(pdf|pptx)$/i.exec(name)?.[1].toLowerCase() || 'file';
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function catalog(db) {
  db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;' +
    'CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, stamp TEXT NOT NULL, problem TEXT);' +
    'CREATE TABLE IF NOT EXISTS passages(id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT, text TEXT, locator TEXT, strength INTEGER, model TEXT, vector BLOB);' +
    'CREATE INDEX IF NOT EXISTS by_doc ON passages(doc);' +
    'CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(title, body, metadata);' +
    "CREATE VIRTUAL TABLE IF NOT EXISTS vocabulary USING fts5vocab(words,'row');");
}
function remove(db, id) {
  db.prepare('DELETE FROM words WHERE rowid IN (SELECT id FROM passages WHERE doc=?)').run(id);
  db.prepare('DELETE FROM passages WHERE doc=?').run(id);
  db.prepare('DELETE FROM docs WHERE id=?').run(id);
}
async function sources(store, snap) {
  const records = new Map(snap.records.map(entry => [entry.record.id, entry]));
  const associations = new Map();
  for (const entry of snap.records) {
    const rec = entry.record;
    for (const id of new Set([rec.id, ...(rec.sources || []), ...(rec.evidence || []), ...(rec.run?.evidence || []), ...comparisonImages(rec.comparison)])) {
      const groups = associations.get(id) || [];
      groups.push({ phase: rec.phaseId, dates: activityDates(entry) }); associations.set(id, groups);
    }
  }
  const result = new Map();
  const included = snap.project.search?.sourceIds;
  for (const doc of snap.documents) {
    if (doc.sourceId && included && !included.includes(doc.sourceId)) continue;
    const entry = records.get(doc.id), format = formatOf(doc.relativePath);
    const source = { id: doc.id, title: doc.title, format, memberships: associations.get(doc.id) || [], metadata: doc.id, stamp: '', external: Boolean(doc.sourceId) };
    if (entry) {
      const rec = entry.record, phase = snap.project.phases.find(p => p.id === rec.phaseId);
      source.metadata = [rec.id, rec.run?.id, phase?.title, ...Object.values(rec.fields), ...Object.values(rec.run?.context || {})].filter(Boolean).join(' ');
      source.runId = rec.run?.id;
      source.stamp = entry.revision;
      source.read = async () => markdownPassages((await store.read(doc.id)).body);
    } else {
      try {
        const file = doc.sourceId ? (await store.evidenceFile(doc.id)).file.path : path.join(store.root, (await store.indexedDocument(doc.id, doc.relativePath)).relativePath);
        const stat = await fs.stat(file);
        source.stamp = [file,stat.mtimeMs,stat.ctimeMs,stat.size].join('|');
        source.read = async () => {
          if (format === 'file') return [];
          const { bytes } = await readBytes(file, format === 'markdown' ? MAX_DOCUMENT_BYTES : 64 * 1024 * 1024);
          return format === 'markdown' ? markdownPassages(decodeDocument(bytes).content) : reportPassages(format, bytes);
        };
      } catch (error) { source.stamp = 'unavailable'; source.problem = error.message; }
    }
    source.stamp = hash(source.stamp + '\n' + source.title + '\n' + source.metadata);
    result.set(doc.id, source);
  }
  return result;
}
async function refreshIndex(db, docs) {
  const before = new Map(db.prepare('SELECT id,stamp,problem FROM docs').all().map(row => [row.id, row]));
  const insert = db.prepare('INSERT INTO passages(doc,text,locator,strength) VALUES(?,?,?,?)');
  const index = db.prepare('INSERT INTO words(rowid,title,body,metadata) VALUES(?,?,?,?)');
  const problems = [];
  for (const doc of docs.values()) {
    const previous = before.get(doc.id);
    if (previous?.stamp === doc.stamp) {
      if (previous.problem) problems.push({ id: doc.id, message: previous.problem });
      continue;
    }
    let passages = [], problem = doc.problem;
    if (doc.read) {
      try { passages = await doc.read(); } catch (error) { problem = error.message; }
    }
    if (!passages.length) passages = [{ text: doc.title, locator: { kind: 'document' }, strength: 0 }];
    if (problem) problems.push({ id: doc.id, message: problem });
    transaction(db, () => {
      if (db.prepare('SELECT stamp FROM docs WHERE id=?').get(doc.id)?.stamp !== previous?.stamp) return;
      remove(db, doc.id);
      db.prepare('INSERT INTO docs VALUES(?,?,?)').run(doc.id, doc.stamp, problem || null);
      const title = tokens(doc.title).join(' '), meta = tokens(doc.metadata).join(' ');
      for (const passage of passages) {
        for (let begin = 0; begin < passage.text.length; begin += 800) {
          const excerpt = passage.text.slice(begin, begin + 900);
          const { lastInsertRowid } = insert.run(doc.id, excerpt, JSON.stringify(passage.locator), passage.strength);
          index.run(lastInsertRowid, title, tokens((passage.locator.heading || '') + ' ' + excerpt).join(' '), meta);
        }
      }
    });
  }
  transaction(db, () => {
    for (const [id, row] of before) if (!docs.has(id) && db.prepare('SELECT stamp FROM docs WHERE id=?').get(id)?.stamp === row.stamp) remove(db, id);
  });
  return problems;
}
function oneEdit(a, b) {
  if (a.length > b.length) return oneEdit(b, a);
  let i = 0, j = 0, differences = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++differences > 1) return false;
    if (a.length === b.length) i++;
    j++;
  }
  return differences + b.length - j <= 1;
}
function lexical(db, query, aliases, allowed) {
  const words = new Set(tokens(query));
  const normalized = normalize(query);
  for (const [term, variants] of Object.entries(aliases || {})) {
    const group = [term, ...variants];
    if (group.some(v => normalized.includes(normalize(v)))) for (const word of group.flatMap(tokens)) words.add(word);
  }
  for (const term of [...words]) {
    if (!/^[a-z]{4,30}$/.test(term) || db.prepare('SELECT 1 FROM vocabulary WHERE term=?').get(term)) continue;
    for (const { term: near } of db.prepare('SELECT term FROM vocabulary WHERE term GLOB ? AND length(term) BETWEEN ? AND ? ORDER BY doc DESC LIMIT 1200').all('[a-z]*', term.length-1,term.length+1)) {
      if (oneEdit(term, near)) words.add(near);
    }
  }
  const expression = [...words].slice(0, 120).map(w => '"' + w.replaceAll('"','""') + '"' + (/^[a-z]{4,}$/.test(w) ? '*' : '')).join(' OR ');
  if (!expression) return [];
  return db.prepare('SELECT rowid AS id FROM words WHERE words MATCH ? ORDER BY bm25(words,4,1,1.5)').all(expression)
    .map(row => row.id).filter(id => allowed.has(id));
}
async function semantic(db, query, rows, docs) {
  if (!rows.length) return [];
  const [needle] = await embed(['query: ' + query]);
  const scores = [];
  const save = db.prepare('UPDATE passages SET model=?,vector=? WHERE id=?');
  const cached = db.prepare('SELECT model,vector FROM passages WHERE id=?');
  for (let i = 0; i < rows.length; i += 4) {
    const batch = rows.slice(i, i+4), pending = [], vectors = new Map();
    for (const row of batch) {
      const data = cached.get(row.id);
      if (data?.model === modelId && data.vector?.length === needle.length * 4) vectors.set(row.id, new Float32Array(Uint8Array.from(data.vector).buffer));
      else pending.push(row);
    }
    if (pending.length) {
      const values = await embed(pending.map(row => 'passage: ' + docs.get(row.doc).title + ' ' + (row.locator.heading || '') + ' ' + row.text));
      transaction(db, () => pending.forEach((row, n) => {
        vectors.set(row.id, values[n]); save.run(modelId, Buffer.from(values[n].buffer), row.id);
      }));
    }
    for (const row of batch) {
      const vec = vectors.get(row.id);
      let score = 0;
      for (let n = 0; n < needle.length; n++) score += needle[n] * vec[n];
      scores.push({ id: row.id, score });
    }
  }
  scores.sort((a,b) => b.score - a.score);
  return scores.filter(s => s.score >= scores[0].score - .09).map(s => s.id);
}
function inRange(doc, locator, opt) {
  if (opt.format !== 'all' && opt.format !== doc.format) return false;
  if (!opt.phase && !opt.from && !opt.to) return true;
  return doc.memberships.some(({ phase, dates }) => (!opt.phase || phase === opt.phase) &&
    (!opt.from && !opt.to || (locator.date ? [locator.date] : dates).some(d => (!opt.from || d >= opt.from) && (!opt.to || d <= opt.to))));
}
const comparingTime = s => /(?:计时|耗时|用时|帧时间|延迟|时延|花.{0,8}时间|timings?|latency|frame\s*time|benchmark)/i.test(s) &&
  /(?:对照|比较|对比|比.{0,6}快|各|几个|不同|四个|表|逐|compar|benchmark)/i.test(s);
function groupResults(rows, docs, rankings, opt) {
  const scores = new Map();
  for (const ranking of rankings) ranking.slice(0,Math.max(80,opt.limit*8)).forEach((id,i) => scores.set(id,(scores.get(id) || 0) + 1/(60+i+1)));
  const query = normalize(opt.query), table = comparingTime(query);
  for (const row of rows.values()) {
    const doc = docs.get(row.doc);
    if (doc.id === query || doc.runId && normalize(doc.runId) === query || normalize(doc.title) === query) scores.set(row.id, (scores.get(row.id) || 0)+1);
    if (table && scores.has(row.id)) scores.set(row.id, scores.get(row.id) + row.strength*.012);
  }
  const groups = new Map();
  for (const [id] of [...scores].sort((a,b) => b[1]-a[1] || a[0]-b[0])) {
    const row = rows.get(id), doc = docs.get(row.doc);
    if (!groups.has(doc.id)) {
      if (groups.size >= opt.limit) continue;
      groups.set(doc.id,{ id: doc.id, title: doc.title, format: doc.format, hits: [] });
    }
    const group = groups.get(doc.id);
    if (group.hits.length >= 4 || group.hits.some(h => JSON.stringify(h.locator) === JSON.stringify(row.locator))) continue;
    const at = normalize(row.text).indexOf(query), start = Math.max(0,at-50);
    group.hits.push({ locator: row.locator, snippet: (start ? '…' : '') + row.text.slice(start,start+210) + (row.text.length > start+210 ? '…' : ''), dataTable: Boolean(row.strength) });
  }
  return [...groups.values()];
}
async function searchProject(store, input) {
  const opt = options(input), snap = await store.snapshot();
  if (opt.phase) assert(snap.project.phases.some(p => p.id === opt.phase), 'Unknown phase.');
  const folder = path.join(searchHome(), 'indexes');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(folder, hash(pathKey(store.root)+'\n'+snap.project.id) + '-v1.sqlite'));
  try {
    catalog(db);
    const docs = await sources(store,snap), problems = await refreshIndex(db,docs);
    const rows = new Map();
    for (const row of db.prepare('SELECT id,doc,text,locator,strength FROM passages ORDER BY id').iterate()) {
      const doc = docs.get(row.doc);
      row.locator = JSON.parse(row.locator);
      if (doc && inRange(doc,row.locator,opt)) rows.set(row.id,row);
    }
    const rankings = [lexical(db,opt.query,snap.project.search?.aliases,rows)];
    let mode = opt.mode, warning;
    if (mode === 'concept') {
      try { rankings.push(await semantic(db,opt.query,[...rows.values()],docs)); }
      catch (error) { mode = 'keyword'; warning = error.message; }
    }
    return { mode, ...(warning && { warning }), problems, results: groupResults(rows,docs,rankings,opt) };
  } finally { db.close(); }
}
module.exports = { searchProject };

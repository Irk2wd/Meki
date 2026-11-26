'use strict';

const { isDate } = require('./research-model.cjs');
const trialHeading = /^##[ \t]+(?:实验试次|Trials)(?:[ \t]+#+)?[ \t]*$/i;
const tableHeading = /^\|?\s*(?:试次\s*ID|Trial ID)\s*\|\s*(?:实验日期|Date)\s*(?:\||$)/i;
const separator = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?$/;

// Only the two index columns belong to mekiR. Leave the project's other cells as Markdown.
function readTrialLog(body) {
  const trials = [], issues = [];
  if (!/(实验试次|trials)/i.test(body)) return { trials, issues };
  const ids = new Set();
  let section = false, table = '', fence = '', comment = false;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd().replace(/^ {0,3}/, '');
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (fence) {
      if (line.startsWith(fence) && /^(?:`+|~+)$/.test(line)) fence = '';
      continue;
    }
    if (/^(?: {4}|\t)/.test(raw)) { table = ''; continue; }
    const marker = /^(`{3,}|~{3,})/.exec(line);
    if (marker) { fence = marker[1]; table = ''; continue; }
    if (line.startsWith('<!--')) { comment = !line.includes('-->'); table = ''; continue; }
    if (/^#{1,6}(?:\s|$)/.test(line)) { section = trialHeading.test(line); table = ''; continue; }
    if (!section) continue;
    if (tableHeading.test(line)) { table = 'header'; continue; }
    if (table === 'header') { table = separator.test(line) ? 'rows' : ''; continue; }
    if (table !== 'rows') continue;
    if (!line || /^\s/.test(line) || !line.includes('|')) { table = ''; continue; }
    const [first, second] = line.replace(/^\|/, '').split('|', 2);
    const id = first.trim(), date = second?.trim() || '';
    if (!id && !date) continue;
    if (!id || !isDate(date)) { issues.push(`Invalid trial ID or date: ${id} / ${date}.`); continue; }
    if (ids.has(id)) { issues.push(`Duplicate trial ID: ${id}.`); continue; }
    ids.add(id);
    trials.push({ id, date });
  }
  return { trials, issues };
}

module.exports = { readTrialLog };

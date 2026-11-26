export function activityDates({ record, trials }) {
  if (!trials?.length) return [record.date];
  return [...new Set([record.date, ...trials.map(trial => trial.date)])].sort();
}

export const monthTerms = /(?<!\d)(0?[1-9]|1[0-2])\s*月/g;

export function monthFilter({ month, query = '' } = {}) {
  const terms = [...query.normalize('NFKC').matchAll(monthTerms)].map(match => Number(match[1]));
  if (!month && !terms.length) return undefined;
  return date => (!month || date.startsWith(`${month}-`)) && terms.every(term => Number(date.slice(5, 7)) === term);
}

export function latestActivity(entry, from = '', to = '9999-12-31', accepts) {
  const inRange = date => date >= from && date <= to && (!accepts || accepts(date));
  const first = entry.record.date;
  let latest = inRange(first) ? first : '';
  for (const { date } of entry.trials || []) {
    if (date > latest && inRange(date)) latest = date;
  }
  return latest;
}

export const sortEntries = (a, b) =>
  latestActivity(a).localeCompare(latestActivity(b)) || a.record.id.localeCompare(b.record.id);

export const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

export function projectToday(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts();
  const value = (key) => parts.find(part => part.type === key).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function phaseSpan({ start, end }, today) {
  return { start, end: end ?? (today < start ? start : today) };
}

export function summaryCoversPhase(record, phase, phases, today) {
  if (record.phaseId === phase.id) return true;
  const range = record.coverage;
  const span = phaseSpan(phase, today);
  if (!range || !overlaps(range, span)) return false;
  const primary = phases.find(item => item.id === record.phaseId);
  if (!primary) return true;
  const primarySpan = phaseSpan(primary, today);
  // Adjacent phases can overlap. Only coverage outside the primary phase extends the association.
  return (range.start < primarySpan.start && span.start < primarySpan.start)
    || (range.end > primarySpan.end && span.end > primarySpan.end);
}

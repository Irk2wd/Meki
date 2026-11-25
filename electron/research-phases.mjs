export const sortEntries = (a, b) =>
  a.record.date.localeCompare(b.record.date) || a.record.id.localeCompare(b.record.id);

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

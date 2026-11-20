import { ht } from '../electron/i18n.mjs';
import type { ResearchRange } from '../shared/research';

export type RangeHandle = 'start' | 'move' | 'end';
export interface TimelineWindow { bounds: ResearchRange; start: number; days: number }
interface DayRange { start: number; end: number }

export const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
export const isoDay = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
export const datesForDays = ({ start, end }: DayRange): ResearchRange => ({ start: isoDay(start), end: isoDay(end) });

function shiftDays(bounds: ResearchRange, start: number, length: number): DayRange {
  const first = dayNumber(bounds.start), last = dayNumber(bounds.end);
  const days = Math.max(1, Math.min(length, last - first + 1));
  const left = Math.max(first, Math.min(start, last - days + 1));
  return { start: left, end: left + days - 1 };
}

export function shiftRange(bounds: ResearchRange, start: number, length: number): ResearchRange {
  return datesForDays(shiftDays(bounds, start, length));
}

export function adjustDays({ bounds, start, days }: TimelineWindow, handle: RangeHandle, delta: number): DayRange {
  const end = start + days - 1;
  if (handle === 'start') return { start: Math.max(dayNumber(bounds.start), Math.min(start + delta, end)), end };
  if (handle === 'end') return { start, end: Math.min(dayNumber(bounds.end), Math.max(end + delta, start)) };
  return shiftDays(bounds, start + delta, days);
}

export function brushDays(anchor: number, point: number, first: number, last: number): DayRange {
  const current = Math.max(first, Math.min(point, last));
  return { start: Math.min(anchor, current), end: Math.max(anchor, current) };
}

export function timelineOverview(range: ResearchRange, bounds: ResearchRange, phases: ResearchRange[]) {
  const first = dayNumber(bounds.start), last = dayNumber(bounds.end), days = last - first + 1;
  const start = dayNumber(range.start) - first, end = dayNumber(range.end) - first;
  const full = end - start + 1 === days;
  const percent = (value: number) => `${value * 100 / days}%`;
  const bars = phases.map((phase, index) => {
    const left = Math.max(first, dayNumber(phase.start)), right = Math.min(last, dayNumber(phase.end));
    return left <= right ? `<i style="--left:${percent(left - first)};--width:${percent(right - left + 1)};--lane:${index % 3}"></i>` : '';
  }).join('');
  const control = (handle: RangeHandle, label: string, min: number, max: number, value: number, valueText: string) => {
    const disabled = min === max && (handle === 'move' || days === 1);
    return `<div data-research-overview-handle="${handle}" role="slider" tabindex="${disabled ? -1 : 0}"
      aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}"
      aria-valuetext="${valueText}" aria-disabled="${disabled}" title="${handle === 'move' && full ? ht("拖动以框选日期") : label}"></div>`;
  };
  return `<div class="research-range-overview" role="group" aria-labelledby="research-range-overview-label">
    <div class="research-range-overview-label"><strong id="research-range-overview-label">${ht("项目全程")}</strong>
      ${days > 1 ? `<small>${ht("框选日期，拖动选区或调整两端")}</small>` : ''}</div>
    <div class="research-range-overview-scale">
      <div class="research-range-overview-rail" data-research-overview style="--range-left:${percent(start)};--range-width:${percent(end - start + 1)}"${full ? ' data-full-range' : ''}${days === 1 ? ' data-single-day' : ''}
          title="${days > 1 ? ht("拖动以框选日期") : bounds.start}">
        <div class="research-range-overview-bands" aria-hidden="true">${bars}</div>
        <div class="research-range-overview-window">
          ${control('start', ht("调整区间开始日期"), 0, end, start, range.start)}
          ${control('move', ht("平移选中区间"), 0, days - (end - start + 1), start, `${range.start} – ${range.end}`)}
          ${control('end', ht("调整区间结束日期"), start, days - 1, end, range.end)}
        </div>
        <div class="research-range-readout" aria-hidden="true"><span data-tip="start">${range.start}</span><span data-tip="move">${range.start} – ${range.end}</span><span data-tip="end">${range.end}</span></div>
      </div>
      <div class="research-range-overview-dates"><time datetime="${bounds.start}">${bounds.start}</time>
        ${days > 1 ? `<time datetime="${bounds.end}">${bounds.end}</time>` : ''}</div>
    </div>
  </div>`;
}

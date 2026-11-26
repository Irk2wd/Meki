import { ht } from '../electron/i18n.mjs';
import type { ResearchEntry, ResearchType } from '../shared/research';
import { escapeResearch as escape } from './research-tools';
import { recordKind, recordMark } from './research-record-mark';

export interface TimelineEventDay {
  point: number;
  entries: ResearchEntry[];
  latest: boolean;
}

interface Placement {
  first: number;
  last: number;
  count: number;
  left: number;
  width: number;
}

interface MarkerPosition { left: number; width: number; key: string }
type MarkerPositions = Map<string, MarkerPosition>;
const markerSelector = 'button[data-research-timeline-events]';
const layerSelector = '.research-timeline-events';
const markerGap = 5;

export function timelineEventButton(root: HTMLElement, key: string) {
  const ids = new Set(key.split(' '));
  const markers = [...root.querySelectorAll<HTMLButtonElement>(markerSelector)];
  return markers.find(marker => marker.dataset.researchTimelineEvents === key) ??
    markers.find(marker => marker.dataset.researchTimelineEvents!.split(' ').some(id => ids.has(id)));
}

function rememberPositions(layer: HTMLElement, positions: MarkerPositions) {
  const origin = layer.getBoundingClientRect().left;
  for (const marker of layer.querySelectorAll<HTMLButtonElement>(markerSelector)) {
    const { left, width } = marker.getBoundingClientRect();
    const key = marker.dataset.researchTimelineEvents!;
    const position = { left: left - origin, width, key };
    for (const id of key.split(' ')) positions.set(id, position);
  }
}

function symbols(glyphs: string[], extra: number) {
  return glyphs.join('') + (extra ? `<small aria-hidden="true">+${extra}</small>` : '');
}

function measureMarkers(layer: HTMLElement) {
  const sizes = new Map<string, number>();
  return (iconCount: number, extra: number) => {
    const key = `${iconCount}/${extra ? String(extra).length : 0}`;
    const cached = sizes.get(key);
    if (cached !== undefined) return cached;
    const probe = document.createElement('span');
    probe.className = 'research-timeline-event';
    probe.style.cssText = 'visibility:hidden;max-width:none';
    probe.setAttribute('aria-hidden', 'true');
    probe.innerHTML = symbols(Array<string>(iconCount).fill(recordMark('event', 14)), extra);
    layer.append(probe);
    const width = probe.offsetWidth;
    probe.remove();
    sizes.set(key, width);
    return width;
  };
}

function placeMarkers(days: TimelineEventDay[], glyphs: string[][], width: number, measure: ReturnType<typeof measureMarkers>) {
  const place = (first: number, last: number, count: number): Placement => {
    const iconCount = first === last ? glyphs[first].length : 1;
    const size = Math.min(width, measure(iconCount, count - iconCount));
    const center = (days[first].point + days[last].point) * width / 2;
    const left = Math.max(0, Math.min(width - size, center - size / 2));
    return { first, last, count, left, width: size };
  };
  const placed: Placement[] = [];
  for (let index = 0; index < days.length; index++) {
    let marker = place(index, index, days[index].entries.length);
    while (placed.length) {
      const previous = placed[placed.length - 1];
      if (previous.left + previous.width + markerGap <= marker.left) break;
      placed.pop();
      marker = place(previous.first, marker.last, previous.count + marker.count);
    }
    placed.push(marker);
  }
  return placed;
}

function eventMarker(entries: ResearchEntry[], glyphs: string[], left: number, latest: boolean) {
  const first = entries[0].record;
  const last = entries[entries.length - 1].record;
  const dates = first.date === last.date ? first.date : `${first.date} – ${last.date}`;
  const comparisons = entries.every(({ record }) => record.comparison);
  const label = entries.length === 1
    ? comparisons ? ht("打开可视化展示 {0}", escape(first.title)) : ht("打开事件 {0}", escape(first.title))
    : comparisons ? ht("{0} 的 {1} 条可视化展示", dates, entries.length) : ht("{0} 的 {1} 个事件", dates, entries.length);
  const key = entries.map(({ record }) => record.id).join(' ');
  const description = latest ? ht("本阶段最近事件") : '';
  return `<button type="button" class="research-timeline-event${comparisons ? ' research-timeline-comparison' : ''}"
    style="left:${left}px" data-research-timeline-events="${escape(key)}" data-date="${escape(dates)}"
    ${description ? `data-latest-event aria-description="${description}"` : ''}
    ${entries.length > 1 || comparisons ? 'aria-haspopup="dialog"' : ''} aria-label="${label}" title="${description ? `${label} · ${description}` : label}">
    ${symbols(glyphs, entries.length - glyphs.length)}</button>`;
}

function animateMarkers(layer: HTMLElement, placed: Placement[], previous: MarkerPositions, trackWidth: number) {
  if (!previous.size) return;
  for (const [index, marker] of [...layer.querySelectorAll<HTMLButtonElement>(markerSelector)].entries()) {
    const key = marker.dataset.researchTimelineEvents!;
    const origin = key.split(' ').map(id => previous.get(id)).find(position => position !== undefined);
    if (!origin) continue;
    const { width, left } = placed[index];
    const center = origin.left + origin.width / 2;
    const from = Math.max(0, Math.min(trackWidth - width, center - width / 2));
    const delta = from - left;
    const regrouped = origin.key !== key;
    if (!regrouped && Math.abs(delta) < 0.5) continue;
    marker.animate([
      { transform: `translateX(${delta}px) scale(${regrouped ? 0.9 : 1})`, opacity: regrouped ? 0.65 : 1 },
      { transform: 'translateX(0) scale(1)', opacity: 1 },
    ], { duration: 180, easing: 'cubic-bezier(.22,.75,.25,1)' });
  }
}

export class TimelineEventLayout {
  private daysByPhase?: Map<string, TimelineEventDay[]>;
  private types = new Map<string, ResearchType>();
  private widths = new WeakMap<HTMLElement, number>();

  constructor(private content: HTMLElement) {}

  capture() {
    const positions: MarkerPositions = new Map();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const layer of this.content.querySelectorAll<HTMLElement>(layerSelector)) rememberPositions(layer, positions);
    }
    return positions;
  }

  show(daysByPhase?: Map<string, TimelineEventDay[]>, types = new Map<string, ResearchType>(), previous?: MarkerPositions) {
    this.daysByPhase = daysByPhase;
    this.types = types;
    this.layout(previous);
  }

  layout(previous?: MarkerPositions) {
    const daysByPhase = this.daysByPhase;
    if (!daysByPhase) return;
    const tracks = [...this.content.querySelectorAll<HTMLElement>(layerSelector)].flatMap(layer => {
      const width = layer.clientWidth;
      const days = daysByPhase.get(layer.dataset.phase!);
      return width && days?.length && this.widths.get(layer) !== width ? [{ layer, width, days }] : [];
    });
    if (!tracks.length) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = reducedMotion ? new Map() : previous ?? this.capture();
    const measure = measureMarkers(tracks[0].layer);
    for (const { layer, width, days } of tracks) {
      this.widths.set(layer, width);
      const focused = document.activeElement;
      const focusKey = focused instanceof HTMLButtonElement && layer.contains(focused) && focused.dataset.researchTimelineEvents;
      const glyphs = days.map(({ entries }) => [...new Map(entries.map(({ record }) => {
        const type = this.types.get(record.type);
        return [record.type, recordMark(recordKind(type, record), 14, type?.icon)] as const;
      })).values()].slice(0, 2));
      const placed = placeMarkers(days, glyphs, width, measure);
      layer.innerHTML = placed.map(({ first, last, left }) => {
        const cluster = days.slice(first, last + 1);
        return eventMarker(cluster.flatMap(day => day.entries), first === last ? glyphs[first] : glyphs[first].slice(0, 1),
          left, cluster.some(day => day.latest));
      }).join('');
      animateMarkers(layer, placed, before, width);
      if (focusKey) timelineEventButton(layer, focusKey)?.focus({ preventScroll: true });
    }
  }
}

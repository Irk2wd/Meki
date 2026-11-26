import { getLocale, ht, t } from '../electron/i18n.mjs';
import { activityDates, latestActivity, monthFilter, overlaps, phaseSpan, projectToday, sortEntries, summaryCoversPhase } from '../electron/research-phases.mjs';
import { comparisonImages } from '../electron/research-comparison.mjs';
import { researchReportFormat } from '../electron/research-report-format.mjs';
import type { LinkedResearchSummary, ResearchBatch, ResearchEntry, ResearchField, ResearchFilter, ResearchPhase, ResearchRange, ResearchRelation, ResearchSnapshot, ResearchType, ResearchValue, ResearchView } from '../shared/research';
import { icon } from './icons';
import { ComparisonGridEditor, ComparisonViewer } from './research-comparison';
import { ResearchColumns } from './research-columns';
import { evidenceWipe, placeReaderFigure, supportsWipe, type WipePosition } from './research-wipe';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TimelineEventLayout, timelineEventButton, type TimelineEventDay } from './research-timeline-events';
import { adjustDays, brushDays, datesForDays, dayNumber, isoDay, shiftRange, timelineOverview, type RangeHandle, type TimelineWindow } from './research-timeline-range';
import { reportReferences } from './research-report-links';
import { recordKind, recordMark } from './research-record-mark';
import { comparisonSample, EvidenceSamples } from './research-evidence-samples';
import { escapeResearch as escape, fieldRuleDetails, fieldValue, relationLabels, researchOption as option, ResearchTools, runFields, type ResearchWidths } from './research-tools';
import './research-workspace.css';

const errorText = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');
const rangeText = (range: ResearchRange) => `${range.start} – ${range.end}`;
const formatDay = (day: number, year = false) => new Intl.DateTimeFormat(getLocale(), { year: year ? 'numeric' : undefined, month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(day * 86400000);
const containsDay = (range: ResearchRange, date: string) => range.start <= date && date <= range.end;
const rangePresets = [
  { id: '7d', amount: 7, unit: 'days' },
  { id: '14d', amount: 14, unit: 'days' },
  { id: '1m', amount: 1, unit: 'months' },
  { id: '3m', amount: 3, unit: 'months' },
] as const;
type RangePreset = typeof rangePresets[number];
type TimelineRange = ResearchRange | RangePreset;
const pageSizeKey = 'mekir.research.phasesPerPage';
const widthsKey = 'mekir.research.widths';
const defaultPageSize = 10;
const peekItems = '.research-entry-title > [data-research-record], .research-summary-list li > [data-research-record]';
const validPageSize = (size: number) => Number.isSafeInteger(size) && size > 0;

function savedPageSize() {
  try {
    const stored = localStorage.getItem(pageSizeKey);
    if (stored === 'all') return null;
    const size = Number(stored);
    if (validPageSize(size)) return size;
  } catch { /* Display preferences are optional. */ }
  return defaultPageSize;
}

function savedWidths(): ResearchWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(widthsKey) || '{}');
    return { workspace: saved.workspace === 'comfort' ? 'comfort' : 'edge', comparison: saved.comparison === 'comfort' ? 'comfort' : 'edge' };
  } catch { return { workspace: 'edge', comparison: 'edge' }; }
}

function phaseDates({ start, end }: ResearchPhase, today: string, short = false) {
  const display = (date: string) => short ? formatDay(dayNumber(date)) : date;
  if (end != null) return `${display(start)} – ${display(end)}`;
  return today < start ? t("{0} 开始", display(start)) : t("{0} 至今", display(start));
}
function resolveTimelineRange(selection: TimelineRange | undefined, today: string): ResearchRange | undefined {
  if (!selection || !('unit' in selection)) return selection;
  if (selection.unit === 'days') return { start: isoDay(dayNumber(today) - selection.amount + 1), end: today };

  const start = new Date(`${today}T00:00:00Z`);
  const day = start.getUTCDate();
  // Find the last day of the target month before clamping the inclusive range.
  start.setUTCMonth(start.getUTCMonth() - selection.amount + 1, 0);
  start.setUTCDate(Math.min(day, start.getUTCDate()) + 1);
  return { start: start.toISOString().slice(0, 10), end: today };
}

function timelineBounds({ project, records }: ResearchSnapshot, today: string): ResearchRange {
  const first = project.start ?? [...project.phases.map(phase => phase.start), ...records.map(entry => activityDates(entry)[0])]
    .reduce((earliest, date) => date < earliest ? date : earliest, today);
  return { start: first < today ? first : today, end: today };
}

function clipRange(range: ResearchRange | undefined, bounds: ResearchRange) {
  if (!range) return bounds;
  const clip = (date: string) => date < bounds.start ? bounds.start : date > bounds.end ? bounds.end : date;
  return { start: clip(range.start), end: clip(range.end) };
}

function groupByPhase(entries: ResearchEntry[]) {
  const phases = new Map<string, ResearchEntry[]>();
  for (const entry of entries) {
    const { phaseId } = entry.record;
    if (!phaseId) continue;
    const group = phases.get(phaseId);
    if (group) group.push(entry);
    else phases.set(phaseId, [entry]);
  }
  return phases;
}

function fieldControl(rule: ResearchField, value: ResearchValue | undefined, validate: boolean) {
  const name = `name="field-${rule.id}"${validate && rule.required ? ' required' : ''}`;
  const text = value === undefined ? '' : String(value);
  if (rule.type === 'choice' || rule.type === 'boolean') {
    const values = rule.type === 'boolean' ? ['true', 'false'] : rule.options!;
    const options = values.map(value => option(value, rule.type === 'boolean' ? fieldValue(rule, value === 'true') : value, text)).join('');
    const historical = !validate && text && !values.includes(text) ? option(text, t("历史值 {0}", text), text) : '';
    return `<select ${name}>${option('', t("未填写"), text)}${historical}${options}</select>`;
  }
  const bounds = validate ? `${rule.min === undefined ? '' : ` min="${rule.min}"`}${rule.max === undefined ? '' : ` max="${rule.max}"`}` : '';
  const number = rule.type === 'number' ? ` step="any"${bounds}` : '';
  return `<input ${name} type="${rule.type}" value="${escape(text)}" maxlength="1000"${number}>`;
}

interface TimelineOptions {
  revealPhase?: string;
  activePhase: string;
  today: string;
  range: ResearchRange;
  bounds: ResearchRange;
  selectedRange: boolean;
  presetId?: RangePreset['id'];
  page: number;
  pageSize: number | null;
  canCreatePhase: boolean;
  canCreateEvent: boolean;
  types: Map<string, ResearchType>;
}

const phaseGroupOrder = { ongoing: 0, ended: 1, upcoming: 2 } as const;
const endedStatuses = new Set(['ended', 'finished', 'completed', 'done', 'succeeded', 'failed', 'canceled', 'cancelled', '已结束', '已完成', '完成', '失败', '已取消']);
const activeStatuses = new Set(['running', 'ongoing', 'in progress', '进行中', '运行中']);

function experimentEnded({ fields, run }: ResearchEntry['record'], phaseEnded: boolean) {
  for (const status of [fields.status, run?.status]) {
    if (typeof status !== 'string') continue;
    const value = status.trim().toLowerCase().replace(/[-_]/g, ' ');
    if (endedStatuses.has(value)) return true;
    if (activeStatuses.has(value)) return false;
  }
  return phaseEnded;
}

function comparePhaseProgress(a: ResearchEntry, b: ResearchEntry, recordTypes: ResearchType[], today: string) {
  const byDate = latestActivity(a, '', today).localeCompare(latestActivity(b, '', today));
  if (byDate) return byDate;
  const isSummary = ({ record }: ResearchEntry) => Boolean(record.coverage) ||
    recordTypes.some(type => type.id === record.type && type.kind === 'summary');
  return Number(isSummary(a)) - Number(isSummary(b)) || a.record.id.localeCompare(b.record.id);
}

function rankPhases(phases: ResearchPhase[], entries: ResearchEntry[], today: string, recordTypes: ResearchType[], progressByPhase?: Map<string, ResearchEntry[]>) {
  const byPhase = groupByPhase(entries);
  const reportTypes = new Set(recordTypes.filter(type => type.kind === 'entry' || type.kind === 'summary').map(type => type.id));
  return phases.map(phase => {
    const span = phaseSpan(phase, today);
    const assigned = byPhase.get(phase.id) || [];
    let latest = '';
    let update: ResearchEntry | undefined;
    for (const item of [...assigned, ...(progressByPhase?.get(phase.id) || [])]) {
      const { record, excerpt } = item;
      const day = latestActivity(item, '', today);
      if (!day) continue;
      if (day > latest) latest = day;
      if (!excerpt && (record.coverage || reportTypes.has(record.type))) continue;
      if (!update || comparePhaseProgress(update, item, recordTypes, today) < 0) update = item;
    }
    const group: keyof typeof phaseGroupOrder = today < span.start ? 'upcoming' : today > span.end ? 'ended' : 'ongoing';
    return { phase, span, group, latest, assigned, update };
  }).sort((a, b) => {
    if (a.group !== b.group) return phaseGroupOrder[a.group] - phaseGroupOrder[b.group];
    if (a.group === 'ended') return b.span.end.localeCompare(a.span.end);
    if (a.group === 'upcoming') return a.span.start.localeCompare(b.span.start);
    return b.latest.localeCompare(a.latest);
  });
}

function timeline(phases: ResearchPhase[], entries: ResearchEntry[], progressByPhase: Map<string, ResearchEntry[]>, eventsByPhase: Map<string, ResearchEntry[]>,
  { activePhase, today, range, bounds, selectedRange, presetId, page: requestedPage, pageSize, revealPhase, canCreatePhase, canCreateEvent, types }: TimelineOptions) {
  const start = dayNumber(range.start), end = dayNumber(range.end), span = end - start + 1;
  const dayWidth = 100 / span;
  const fullRange = range.start === bounds.start && range.end === bounds.end;
  const crossesYear = new Date(start * 86400000).getUTCFullYear() !== new Date(end * 86400000).getUTCFullYear();
  const position = (date: string, offset = 0) => (dayNumber(date) - start + offset) * 100 / span;
  const todayLine = containsDay(range, today) ? `<i class="research-today-line" style="--point:${position(today, 0.5)}%"></i>` : '';
  const ticks = [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(start + (end - start) * i / 4)))];
  const tickPosition = (day: number) => (day - start + .5) * 100 / span;
  const ordered = rankPhases(phases, entries, today, [...types.values()], progressByPhase);
  const focusPhase = activePhase || ordered[0]?.phase.id;
  const selectedIndex = revealPhase ? ordered.findIndex(({ phase }) => phase.id === revealPhase) : -1;
  const limit = pageSize ?? Math.max(1, ordered.length);
  const pageCount = Math.max(1, Math.ceil(ordered.length / limit));
  const page = selectedIndex >= 0 ? Math.floor(selectedIndex / limit) + 1 : Math.max(1, Math.min(requestedPage, pageCount));
  const usedTypes = new Set(phases.flatMap(phase => (eventsByPhase.get(phase.id) || []).map(({ record }) => record.type)));
  const legendKey = (type?: ResearchType) => `<span class="research-key-event">${recordMark(type?.kind ?? 'comparison', 13, type?.icon)}${escape(type?.label || t("可视化展示"))}</span>`;
  const eventKeys = new Set([...types.values()].filter(type => usedTypes.has(type.id))
    .map(legendKey));
  if ([...usedTypes].some(id => !types.has(id))) eventKeys.add(legendKey());
  const eventDays = new Map<string, TimelineEventDay[]>();
  const phaseRows = ordered.slice((page - 1) * limit, page * limit).map(({ phase, span, group, latest, assigned, update }) => {
    const activity = new Map<string, ResearchEntry[]>();
    for (const entry of assigned) {
      for (const day of activityDates(entry)) {
        if (!containsDay(range, day)) continue;
        const items = activity.get(day);
        if (items) items.push(entry);
        else activity.set(day, [entry]);
      }
    }
    const dots = [...activity].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => {
      const ended = items.every(({ record }) => experimentEnded(record, group === 'ended'));
      const label = items.length === 1 ? `${day} · ${escape(items[0].record.title)}` : ht("{0} 的 {1} 条实验记录", day, items.length);
      return `<button type="button" class="research-trial-day" data-research-trial-day="${phase.id}/${day}" data-date="${day}"
        data-research-trial-records="${items.map(({ record }) => record.id).join(' ')}" style="--point:${position(day, .5)}%;--day-width:${dayWidth}%" aria-label="${label}" title="${label}">
        <i aria-hidden="true" class="research-timeline-dot${ended ? ' is-ended' : ''}"></i></button>`;
    }).join('');
    const phaseEvents = eventsByPhase.get(phase.id) || [];
    const groups = new Map<string, ResearchEntry[]>();
    let latestEventDate = '';
    for (const event of phaseEvents) {
      const { date } = event.record;
      if (phase.id === focusPhase && date <= today && date > latestEventDate) latestEventDate = date;
      if (!containsDay(range, date)) continue;
      const group = groups.get(date);
      if (group) group.push(event);
      else groups.set(date, [event]);
    }
    if (groups.size) eventDays.set(phase.id, [...groups].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({ point: position(date, 0.5) / 100, entries: entries.sort(sortEntries), latest: date === latestEventDate })));
    const left = Math.max(0, position(span.start)), right = Math.max(0, 100 - position(span.end, 1));
    const status = group === 'ongoing' ? ht("进行中") : group === 'ended' ? ht("已结束") : ht("未开始");
    const progress = update?.excerpt || update?.record.title || phase.description;
    const updateType = update && types.get(update.record.type);
    return `<div class="research-timeline-row" data-status="${group}">
      <button type="button" class="research-timeline-label" data-research-phase="${phase.id}" aria-pressed="${activePhase === phase.id}">
        <strong>${escape(phase.title)} <span class="research-phase-status${group === 'ongoing' ? ' research-phase-ongoing' : ''}">${status}</span></strong>
        ${progress ? `<span class="research-phase-progress" title="${escape(progress)}">${update ? recordMark(recordKind(updateType, update.record), 12, updateType?.icon) : ''}${escape(progress)}</span>` : ''}
        <small class="research-phase-facts"><span>${escape(phaseDates(phase, today, true))} · ${ht("{0} 条实验", assigned.length)}</span>${latest ? `<span>${ht("最近进展 {0}", escape(formatDay(dayNumber(latest), latest.slice(0, 4) !== today.slice(0, 4))))}</span>` : ''}</small></button>
      <div class="research-timeline-track" data-research-track${fullRange ? '' : ' data-research-pan'}${phaseEvents.length ? ' data-research-has-events' : ''}>${overlaps(span, range) ? `<i aria-hidden="true" class="research-timeline-bar" style="--left:${left}%;--right:${right}%"></i>` : ''}${dots}
        ${groups.size ? `<div class="research-timeline-events" data-phase="${phase.id}"></div>` : ''}</div>
    </div>`;
  }).join('');
  const presetButtons = rangePresets.map(({ id, amount, unit }) => {
    const label = unit === 'days' ? ht("{0} 天", amount) : ht("{0} 个月", amount);
    const accessibleLabel = unit === 'days' ? ht("最近 {0} 天", amount) :
      amount === 1 ? ht("最近 1 个月") : ht("最近 {0} 个月", amount);
    return `<button type="button" data-research-range-preset="${id}" aria-pressed="${presetId === id}" aria-label="${accessibleLabel}" title="${accessibleLabel}">${label}</button>`;
  }).join('');
  const pageOptions = `<div class="research-page-options"><label for="research-phase-page-size">${ht("每页阶段数")}</label>
      <input id="research-phase-page-size" type="number" min="1" step="1" value="${pageSize ?? ''}" placeholder="${ht("全部")}">
      ${pageSize !== null ? `<button type="button" class="text-button" data-research-all-phases>${ht("全部阶段")}</button>` : ''}
    </div>`;
  const pager = pageCount > 1 ? `<nav class="research-phase-pages" aria-label="${ht("研究阶段分页")}">
      <button type="button" class="icon-button" data-research-phase-page="-1" aria-label="${ht("上一页")}" title="${ht("上一页")}" aria-describedby="research-phase-page-number"${page === 1 ? ' disabled' : ''}>${icon('back', 16)}</button>
      <span id="research-phase-page-number" role="status">${ht("第 {0} 页，共 {1} 页", page, pageCount)}</span>
      <button type="button" class="icon-button" data-research-phase-page="1" aria-label="${ht("下一页")}" title="${ht("下一页")}" aria-describedby="research-phase-page-number"${page === pageCount ? ' disabled' : ''}>${icon('chevron', 16)}</button>
    </nav>` : '';
  const html = `<section class="research-timeline" aria-labelledby="research-range-title">
    <div class="research-section-heading"><h2 id="research-range-title">${ht("研究阶段")}</h2>
      <div class="research-actions"><div class="research-range-presets" role="group" aria-label="${ht("快捷时间范围")}">${presetButtons}</div>
        <button type="button" class="secondary-button" data-research-range data-start="${range.start}" data-end="${range.end}"
        title="${ht("选择时间范围")}" aria-label="${ht("选择时间范围")} · ${escape(rangeText(range))}">${icon('timeline', 14)}${escape(rangeText(range))}</button>
        ${selectedRange ? `<button type="button" class="text-button" data-research-reset-range>${ht("全部时段")}</button>` : ''}</div>
    </div>
    <div class="research-timeline-meta">
      <div class="research-legend" role="group" aria-label="${ht("时间线图例")}">
        <div class="research-legend-markers" role="group" aria-label="${ht("时间线标记")}">
          <span>${ht("阶段时段")}</span><span class="research-key-point">${ht("实验日期")}</span><span class="research-key-today">${ht("今天")}</span>
        </div>
        ${eventKeys.size ? `<div class="research-legend-events" role="group" aria-label="${ht("自定义事件")}">${[...eventKeys].join('')}</div>` : ''}
      </div>
      <div class="research-axis-controls" role="group" aria-label="${ht("时间轴平移与缩放")}">
        ${[['prev', t("向前移动时间轴"), icon('back', 15), range.start === bounds.start],
          ['next', t("向后移动时间轴"), icon('chevron', 15), range.end === bounds.end],
          ['out', t("缩小时间轴"), '−', fullRange], ['in', t("放大时间轴"), '+', span === 1]].map(([id, label, glyph, disabled]) =>
          `<button type="button" class="icon-button" data-research-axis-action="${id}" aria-label="${escape(String(label))}" title="${escape(String(label))}"${disabled ? ' disabled' : ''}>${glyph}</button>`).join('')}
      </div></div>
    ${timelineOverview(range, bounds, ordered.map(({ span }) => span))}
    <div class="research-phase-chart">
      <div class="research-chart-guides" aria-hidden="true"><div>${ticks.map(day => `<i style="--point:${tickPosition(day)}%"></i>`).join('')}${todayLine}</div></div>
      <div class="research-timeline-axis" aria-hidden="true"><span></span><div class="research-timeline-ruler" data-research-axis${fullRange ? '' : ` data-research-pan title="${ht("拖动时间轴")}"`}>
      ${ticks.map((day, i) => `<span class="${ticks.length === 1 ? '' : i === 0 ? 'first' : i === ticks.length - 1 ? 'last' : 'middle'}" style="--tick:${tickPosition(day)}%">${escape(formatDay(day, crossesYear))}</span>`).join('')}
      </div></div>${phaseRows || `<p class="research-empty-list">${ht("此视图没有研究阶段。")}</p>`}
    </div>
    <footer class="research-timeline-footer"><details class="research-timeline-options"><summary data-research-timeline-options>${icon('settings', 14)}${ht("时间线选项")}${icon('down', 12)}</summary><div class="research-actions">
      ${canCreatePhase ? `<button type="button" class="text-button" data-research-new-phase>${icon('plus', 14)}${ht("新建阶段")}</button>` : ''}
      ${canCreateEvent ? `<button type="button" class="text-button" data-research-new="event">${icon('plus', 14)}${ht("添加事件")}</button>` : ''}
      <button type="button" class="text-button" data-research-event-types>${icon('calendar', 14)}${ht("事件类型")}</button>
      ${phaseRows ? pageOptions : ''}
    </div></details>${pager}</footer>
  </section>`;
  return { html, page, eventDays };
}

type ResearchPage = 'timeline' | 'entries' | 'summaries' | 'sources' | 'rules' | 'view';
interface Destination { key: string; label: string; glyph: string; page: ResearchPage; view?: ResearchView }

function destinations(project: ResearchSnapshot['project']): Destination[] {
  const unscoped = project.views.filter(view => !view.phaseIds);
  const summaryTypes = new Set(project.recordTypes.filter(type => type.kind === 'summary').map(type => type.id));
  const base: Destination[] = [
    { key: 'timeline', label: t("时间线"), glyph: 'timeline', page: 'timeline',
      view: unscoped.find(view => view.layout === 'timeline' && !view.typeIds) },
    { key: 'entries', label: t("实验记录"), glyph: 'list', page: 'entries',
      view: unscoped.find(view => view.layout === 'journal' && !view.typeIds) },
    { key: 'summaries', label: t("阶段总结"), glyph: 'report', page: 'summaries',
      view: unscoped.find(view => view.layout === 'journal' && view.typeIds?.length === summaryTypes.size && view.typeIds.every(id => summaryTypes.has(id))) },
    { key: 'sources', label: t("资料"), glyph: 'folder', page: 'sources' },
  ];
  const used = new Set(base.map(item => item.view?.id));
  return [...base, ...project.views.filter(view => !used.has(view.id)).map((view): Destination => ({
    key: `view:${view.id}`, label: view.label, glyph: view.layout === 'timeline' ? 'timeline' : 'list',
    page: view.layout === 'timeline' ? 'timeline' : 'view', view,
  })), { key: 'rules', label: t("项目设置"), glyph: 'sliders', page: 'rules' }];
}

interface Hooks {
  root(): string | undefined;
  blocked(): boolean;
  whenIdle(): Promise<void>;
  open(root: string, id: string, origin?: HTMLButtonElement, edit?: boolean, sourceProjectId?: string): Promise<void>;
  closeReader(): Promise<void>;
  expandNavigation(): void;
  openProject(root: string): Promise<void>;
  notify(message: string, error?: boolean): void;
}

interface ViewPosition { phaseId: string; date: string; scroll: number; page: number; range?: TimelineRange }
interface AxisDrag extends TimelineWindow {
  part: 'axis' | 'draw' | RangeHandle;
  pointerId: number;
  x: number;
  y: number;
  left: number;
  width: number;
  clientX: number;
  moving: boolean;
}

export class ResearchWorkspace {
  private panel = document.createElement('section');
  private toolbar = document.createElement('header');
  private content = document.createElement('div');
  private dialog = document.createElement('dialog');
  private projectPicker = document.createElement('dialog');
  private rangePicker = document.createElement('dialog');
  private tools: ResearchTools;
  private comparisonViewer = new ComparisonViewer();
  private comparisonGrid?: ComparisonGridEditor;
  private snapshot: ResearchSnapshot | null = null;
  private signature = '';
  private renderedDay = '';
  private root: string | undefined;
  private viewKey = '';
  private phaseId = '';
  private date = '';
  private timelineRange?: TimelineRange;
  private phasePage = 1;
  private phasePageSize = savedPageSize();
  private recordFilter?: ResearchFilter;
  private axisDrag?: AxisDrag;
  private axisFrame = 0;
  private controlPress?: { pointerId: number; release: () => void };
  private controlsIdle = Promise.resolve();
  private widths = savedWidths();
  private timelineEvents = new TimelineEventLayout(this.content);
  private samples = new EvidenceSamples(this.content);
  private columns: ResearchColumns;
  private eventLayout = new ResizeObserver(() => {
    this.columns.update();
    void this.controlsIdle.then(() => this.timelineEvents.layout());
  });
  private positions = new Map<string, ViewPosition>();
  private phaseReading = new Map<string, string>();
  private stageNavigation = false;
  private expandedPhaseGroups = new Set<string>(['ongoing']);
  private sidebarState?: { snapshot: ResearchSnapshot | null; page?: string; phase: string; day: string; reading: boolean };
  private readerContexts = new Map<string, ResearchSnapshot>();
  private readerReturn?: { scroll: number; origin?: HTMLButtonElement };
  private readerItem = '';
  private openingListRecord = false;
  private pendingListRecord?: HTMLButtonElement;
  private figureContext?: { path: string | null; root?: string; snapshot?: ResearchSnapshot; view: EditorView; key?: string };
  private readerWipes = new Map<string, { key: string; position: WipePosition }>();
  private loading = false;
  private loadNumber = 0;
  private referenceRequest = 0;
  private editing: ResearchEntry | undefined;
  private formProject: ResearchSnapshot | null = null;
  private initialFieldValues = new Map<string, string>();
  private submitting = false;
  private savingGoals = false;

  constructor(private host: HTMLElement, private sidebar: HTMLElement, private hooks: Hooks) {
    this.tools = new ResearchTools(this.host.querySelector<HTMLElement>('#document-surface')!, () => this.refresh(), hooks.notify);
    this.panel.id = 'research-workspace';
    this.panel.hidden = true;
    this.toolbar.className = 'research-toolbar';
    this.content.className = 'research-content';
    this.panel.append(this.toolbar, this.content);
    this.host.prepend(this.panel);
    this.columns = new ResearchColumns(this.sidebar.closest('aside')!, this.panel, this.host);
    this.eventLayout.observe(this.content);
    this.eventLayout.observe(this.host);
    this.dialog.id = 'research-record-dialog';
    this.projectPicker.id = 'research-project-picker';
    this.rangePicker.id = 'research-range-picker';
    this.rangePicker.setAttribute('aria-labelledby', 'research-range-picker-title');
    document.body.append(this.dialog, this.projectPicker, this.rangePicker);
    for (const element of [this.sidebar, this.panel]) {
      element.addEventListener('click', event => { void this.click(event).catch(error => this.hooks.notify(errorText(error), true)); });
      element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || this.controlPress || !(event.target as Element).closest('button, summary[data-research-settings-section]')) return;
        this.controlsIdle = new Promise(release => { this.controlPress = { pointerId: event.pointerId, release }; });
      });
    }
    this.sidebar.addEventListener('toggle', event => {
      const shelf = event.target;
      if (!(shelf instanceof HTMLDetailsElement) || !shelf.isConnected || !shelf.dataset.researchPhaseGroup) return;
      if (shelf.open) this.expandedPhaseGroups.add(shelf.dataset.researchPhaseGroup);
      else this.expandedPhaseGroups.delete(shelf.dataset.researchPhaseGroup);
    }, true);
    for (const name of ['pointerup', 'pointercancel'] as const) {
      window.addEventListener(name, event => this.releaseControl(event.pointerId));
    }
    window.addEventListener('blur', () => {
      this.releaseControl();
      this.finishAxisDrag();
    });
    this.content.addEventListener('change', event => {
      const target = event.target as HTMLInputElement;
      if (target.id === 'research-date') {
        this.date = target.value;
        this.render();
        this.content.querySelector<HTMLInputElement>('#research-date')?.focus({ preventScroll: true });
      } else if (target.id === 'research-phase-page-size') {
        if (target.validity.badInput || (target.value && !validPageSize(target.valueAsNumber))) {
          target.value = this.phasePageSize === null ? '' : String(this.phasePageSize);
          return;
        }
        this.setPhasePageSize(target.value === '' ? null : target.valueAsNumber);
      } else if (target.dataset.researchGoal !== undefined) {
        void this.setGoal(Number(target.dataset.researchGoal), target.checked);
      }
    });
    this.content.addEventListener('keydown', event => {
      const target = event.target as HTMLElement;
      const handle = target.dataset.researchOverviewHandle as RangeHandle | undefined;
      if (handle && !event.isComposing) {
        this.moveOverviewHandle(event, handle);
        return;
      }
      if (event.key !== 'Enter' || event.isComposing || target.id !== 'research-phase-page-size') return;
      event.preventDefault();
      target.blur();
    });
    this.content.addEventListener('pointerdown', event => this.beginAxisDrag(event));
    this.content.addEventListener('pointermove', event => this.updateAxisDrag(event));
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.content.addEventListener(name, event => {
        if (name !== 'lostpointercapture' || event.target === this.content) this.finishAxisDrag(event);
      });
    }
    this.content.addEventListener('pointerleave', event => {
      if (!this.axisDrag?.moving) this.finishAxisDrag(event);
    });
    this.content.addEventListener('wheel', event => {
      const axis = (event.target as Element).closest('[data-research-axis], [data-research-track]');
      if (!axis || !(event.ctrlKey || event.metaKey) || this.axisDrag?.moving || this.hooks.blocked()) return;
      event.preventDefault();
      const { left, width } = axis.getBoundingClientRect();
      this.moveAxis(event.deltaY < 0 ? 'in' : 'out', Math.max(0, Math.min(1, (event.clientX - left) / width)), false);
    }, { passive: false });
    this.dialog.addEventListener('cancel', event => { if (this.submitting) event.preventDefault(); });
    this.dialog.addEventListener('click', event => {
      const button = (event.target as Element).closest('button');
      if (!button || this.submitting) return;
      if (button.hasAttribute('data-research-cancel')) this.dialog.close();
      if (button.hasAttribute('data-remove-relation')) button.closest('.research-relation-row')?.remove();
      if (button.hasAttribute('data-add-relation')) {
        const rows = this.dialog.querySelector('[data-research-relations]')!;
        if (rows.childElementCount >= 40) return;
        rows.insertAdjacentHTML('beforeend', this.relationRow());
        rows.lastElementChild?.querySelector('select')?.focus();
      }
    });
    this.dialog.addEventListener('change', event => {
      const target = event.target as HTMLInputElement;
      if (target.name === 'type') this.renderFields();
      if (target.name === 'phaseId' && !this.editing) this.fillCoverage();
    });
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
    this.projectPicker.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-research-project]');
      if (!button || this.hooks.blocked()) return;
      this.projectPicker.close();
      void this.hooks.openProject(button.dataset.researchProject!).catch(error => this.hooks.notify(errorText(error), true));
    });
    this.rangePicker.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-research-cancel]')) this.rangePicker.close();
    });
    this.rangePicker.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      const start = String(data.get('start')), end = String(data.get('end'));
      if (start > end) {
        this.rangePicker.querySelector('[role="alert"]')!.textContent = t("结束日期不能早于开始日期。");
        return;
      }
      this.rangePicker.close();
      this.setTimelineRange({ start, end });
    });
  }

  get visible() { return !this.panel.hidden; }
  get readerOpen() { return Boolean(this.readerReturn); }

  async show() {
    this.panel.hidden = this.sidebar.hidden = false;
    this.host.classList.add('research-mode');
    this.host.closest('.shell')?.classList.add('research-shell');
    this.columns.update();
    await this.refresh();
    this.content.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }

  hide() {
    this.clearAxisDrag();
    this.closeReader(false);
    this.panel.hidden = this.sidebar.hidden = true;
    this.host.classList.remove('research-mode');
    this.host.closest('.shell')?.classList.remove('research-shell');
    this.columns.update();
  }

  openReader(origin?: HTMLButtonElement) {
    this.readerReturn ??= { scroll: this.content.scrollTop, origin };
    if (origin) this.readerReturn.origin = origin;
    this.host.classList.add('research-reader-open');
    this.host.classList.toggle('research-stage-reading', this.stageNavigation && Boolean(this.phaseId));
    this.columns.update();
    if (this.snapshot) this.renderSidebar(this.snapshot, this.destination(this.snapshot));
    if (!this.panel.inert) origin?.scrollIntoView({ block: 'nearest' });
  }

  selectReaderItem(id = '', linkedProject = '', force = false) {
    const key = id ? `${linkedProject}/${id}` : '';
    if (!force && key === this.readerItem) return;
    if (key !== this.readerItem) this.tools.closeEvidence(false);
    this.readerItem = key;
    for (const shortcut of this.sidebar.querySelectorAll<HTMLButtonElement>('[data-research-stage-record]')) {
      if (!linkedProject && shortcut.dataset.researchStageRecord === id) shortcut.setAttribute('aria-current', 'page');
      else shortcut.removeAttribute('aria-current');
    }
    if (!force && id && !linkedProject && this.snapshot) {
      const phase = this.snapshot.records.find(item => item.record.id === id)?.record.phaseId;
      if (phase) this.phaseReading.set(phase, id);
      if (this.phaseId && this.content.querySelector(`.research-journal [data-research-record="${CSS.escape(id)}"]`)) this.phaseReading.set(this.phaseId, id);
    }
    const items = [...this.content.querySelectorAll<HTMLButtonElement>(peekItems)];
    const index = items.findIndex(button => key === `${button.dataset.researchLinkedProject || ''}/${button.dataset.researchRecord}`);
    const previous = items.find(button => button.hasAttribute('aria-current'));
    const active = items[index];
    if (previous !== active) {
      let dy = 0;
      if (previous && active && !this.panel.inert && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const transform = getComputedStyle(previous, '::before').transform;
        dy = previous.getBoundingClientRect().top - active.getBoundingClientRect().top + (transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42);
      }
      previous?.removeAttribute('aria-current');
      active?.setAttribute('aria-current', 'true');
      if (dy && Math.abs(dy) < 260) active.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { pseudoElement: '::before', duration: 160, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('[data-peek-step]')) {
      button.hidden = index < 0 || items.length < 2;
      button.disabled = !items[index + Number(button.dataset.peekStep)];
    }
  }

  stepReader(direction: number) {
    const items = [...this.content.querySelectorAll<HTMLButtonElement>(peekItems)];
    const index = items.findIndex(button => button.hasAttribute('aria-current'));
    if (index >= 0) items[index + direction]?.click();
  }

  async dismissReader() {
    const returning = this.readerReturn;
    if (!returning) return;
    if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.closeReader();
      return;
    }
    const reader = this.host.querySelector<HTMLElement>('#document-surface')!;
    const scrim = this.host.querySelector<HTMLElement>('.research-reader-scrim')!;
    const style = getComputedStyle(reader);
    const readerStart = { opacity: style.opacity, transform: style.transform };
    const scrimStart = { opacity: getComputedStyle(scrim).opacity };
    for (const element of [reader, scrim]) element.getAnimations().forEach(animation => animation.cancel());
    const timing = { duration: 155, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' } as const;
    reader.inert = true;
    const animations = [
      reader.animate([readerStart, { opacity: 0, transform: 'translateX(12px)' }], timing),
      ...(scrim.getClientRects().length ? [scrim.animate([scrimStart, { opacity: 0 }], timing)] : []),
    ];
    try {
      await Promise.allSettled(animations.map(animation => animation.finished));
      if (this.readerReturn === returning) this.closeReader();
    } finally {
      reader.inert = false;
      animations.forEach(animation => animation.cancel());
    }
  }

  closeReader(focus = true) {
    const returning = this.readerReturn;
    if (!returning) return;
    this.tools.closeEvidence(false);
    this.readerReturn = undefined;
    this.host.classList.remove('research-reader-open', 'research-stage-reading');
    this.columns.update();
    if (this.snapshot) this.renderSidebar(this.snapshot, this.destination(this.snapshot));
    this.selectReaderItem();
    this.content.scrollTop = returning.scroll;
    if (focus) {
      const button = returning.origin;
      const id = button?.dataset.researchRecord;
      const events = button?.dataset.researchTimelineEvents;
      const trialDay = button?.dataset.researchTrialDay;
      const linked = button?.dataset.researchLinkedProject;
      const origin = linked ? `[data-research-linked-project="${CSS.escape(linked)}"]` : ':not([data-research-linked-project])';
      const shortcut = button?.dataset.researchStageLink;
      const progress = button?.dataset.researchProgressLink;
      const replacement = shortcut ? this.sidebar.querySelector<HTMLButtonElement>(`[data-research-stage-link="${CSS.escape(shortcut)}"]`) :
        progress ? this.content.querySelector<HTMLButtonElement>(`[data-research-progress-link="${CSS.escape(progress)}"]`) :
        trialDay ? this.content.querySelector<HTMLButtonElement>(`[data-research-trial-day="${CSS.escape(trialDay)}"]`) :
        events ? timelineEventButton(this.content, events) :
        id ? this.content.querySelector<HTMLButtonElement>(`[data-research-record="${CSS.escape(id)}"]${origin}`) : null;
      (button?.isConnected ? button : replacement || this.content.querySelector('h1'))?.focus({ preventScroll: true });
    }
  }

  rememberReaderContext(snapshot: ResearchSnapshot) {
    this.readerContexts.set(snapshot.root, snapshot);
  }

  readerLabel(path: string | null) {
    const context = this.readerReference(path);
    if (!context) return null;
    const { reference, state } = context;
    const entry = state.records.find(item => item.record.id === reference.id)?.record;
    const phase = state.project.phases.find(item => item.id === entry?.phaseId);
    const type = state.project.recordTypes.find(item => item.id === entry?.type);
    const sourceProject = this.snapshot?.root !== state.root ? state.project.title : '';
    return { id: reference.id, linkedProject: sourceProject ? state.project.id : '', mark: recordMark(recordKind(type, entry), 16, type?.icon), hasFields: Boolean(entry && Object.keys(entry.fields).length), title: reference.title, context: [sourceProject, phase?.title, type?.label || t("资料"), entry?.date,
      entry?.run?.missing.includes('RUN.md') ? t("待补报告") : ''].filter(Boolean).join(' · ') };
  }

  private readerReference(path: string | null) {
    if (!path) return null;
    const file = path.replace(/\\/g, '/');
    for (const state of [this.snapshot, ...this.readerContexts.values()]) {
      if (!state) continue;
      const root = state.root.replace(/\\/g, '/').replace(/\/$/, '');
      const reference = state.documents.find(item => !item.sourceId && file === `${root}/${item.relativePath}`);
      if (reference) return { reference, state };
    }
    return null;
  }

  readerRelated(path: string | null) {
    const source = this.readerReference(path);
    if (!source) return '';
    const { reference, state } = source;
    const record = state.records.find(item => item.record.id === reference.id)?.record;
    const run = record?.run;
    const projects = record?.relatedProjects || [];
    const evidence = [...new Set([...(record?.evidence || []), ...(run?.evidence || []), ...comparisonImages(record?.comparison),
      ...(record?.sources || []).filter(id => state.documents.some(file => file.id === id && file.sourceId))])];
    const incoming = state.records.flatMap(({ record }) => (record.relations || []).filter(relation => relation.target === reference.id)
      .map(relation => ({ ...relation, target: record.id, incoming: true })));
    const relations = [...(record?.relations || []), ...incoming];
    if (!run && !evidence.length && !relations.length && !projects.length) return '';
    const references = new Map(state.documents.map(file => [file.id, file]));
    const link = (id: string) => {
      const file = references.get(id);
      return file ? `<button type="button" class="research-related-link" data-research-related="${id}" title="${escape(file.relativePath)}">${escape(file.title)}</button>` : `<code>${escape(id)}</code>`;
    };
    const labels = relationLabels(), fields = runFields();
    const context = run ? { id: run.id, category: run.category, ...(run.status ? { status: run.status } : {}), ...run.context } : undefined;
    const projectNames = projects.length ? `<section><h3>${ht("关联项目")}</h3><div class="research-related-links">${projects.map(projectId => {
      const project = state.knownProjects?.find(item => item.id === projectId);
      return `<span class="research-project-tag" title="${escape(projectId)}">${escape(project?.title || projectId)}</span>`;
    }).join('')}</div></section>` : '';
    return `${projectNames}${evidence.length ? `<section class="research-reader-evidence"><h3>${ht("原始证据")}</h3><div class="research-related-links">${evidence.slice(0, 5).map(link).join('')}</div>
      ${evidence.length > 5 ? `<details><summary>${ht("其余 {0} 个文件", evidence.length - 5)}</summary><div class="research-related-links">${evidence.slice(5).map(link).join('')}</div></details>` : ''}</section>` : ''}
      ${relations.length ? `<section><h3>${ht("研究关系")}</h3><ul class="research-related-relations">${relations.map(relation => `<li>
        <span>${'incoming' in relation ? '← ' : ''}${escape(labels[relation.kind])}</span>${link(relation.target)}${relation.note ? `<small>${escape(relation.note)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
      ${run && context ? `<details><summary>${ht("运行信息")}${run.missing.length ? ` · ${ht("缺件 {0} 项", run.missing.length)}` : ''}</summary>
        <dl>${Object.entries(context).map(([key, value]) => `<dt>${escape(fields[key] || key)}</dt><dd>${escape(value)}</dd>`).join('')}
          ${run.missing.length ? `<dt>${ht("缺件")}</dt><dd>${escape(run.missing.join(', '))}</dd>` : ''}</dl></details>` : ''}`;
  }
  showReaderFields(path: string | null, origin: HTMLElement) {
    const source = this.readerReference(path);
    if (source && path) void this.showFields(source.reference.id, source.state, origin, undefined, path).catch(error => this.hooks.notify(errorText(error), true));
  }
  private async showFields(id: string, state: ResearchSnapshot, origin: HTMLElement, field?: string, path?: string) {
    const root = this.root;
    if (!root) return;
    const request = ++this.referenceRequest;
    const reader = this.readerItem;
    const record = await window.meki.readResearchRecord(root, id, path);
    if (request !== this.referenceRequest || root !== this.root || (path && (!this.readerOpen || reader !== this.readerItem))) return;
    const trigger = origin.isConnected ? origin : field && this.content.querySelector<HTMLElement>(
      `[data-field-record="${CSS.escape(id)}"][data-research-field="${CSS.escape(field)}"]`);
    if (trigger) this.tools.showFieldRules(record, state.manifestFile, trigger, field);
  }

  clearReaderFigures() {
    const previous = this.figureContext;
    this.figureContext = undefined;
    if (previous?.key && !previous.view.isDestroyed) placeReaderFigure(previous.view);
  }

  showReaderFigures(path: string | null, view: EditorView) {
    if (this.figureContext && this.figureContext.path !== path) this.tools.closeEvidence(false);
    if (this.figureContext?.view !== view) this.clearReaderFigures();
    const cached = this.figureContext;
    const source = this.readerReference(path);
    const snapshot = source?.state, root = this.root;
    if (cached && cached.path === path && cached.snapshot === snapshot && cached.root === root) return;
    const entry = source?.state.records.find(item => item.record.id === source.reference.id);
    const references = new Map(source?.state.records.map(item => [item.record.id, item]));
    const ids = entry ? [entry.record.id, ...(entry.record.sources || [])] : [];
    const reports = [...new Set(ids)].flatMap(id => {
      const item = references.get(id);
      return item && supportsWipe(item.record.comparison) ? [item] : [];
    });
    const key = reports.length ? JSON.stringify([root, path, reports.map(item => [item.record.id, item.revision]), snapshot?.evidenceSources]) : undefined;
    this.figureContext = { path, root, snapshot, view, key };
    if (cached?.key === key) return;
    if (!key || !root || !path) { placeReaderFigure(view); return; }
    const holder = document.createElement('section');
    holder.className = 'research-inline-comparisons';
    const previous = this.readerWipes.get(path);
    const position = previous?.key === key ? previous.position : {};
    this.readerWipes.set(path, { key, position });
    holder.append(evidenceWipe(reports.map(({ record }) => ({ title: record.title, comparison: record.comparison! })), {
      read: id => window.meki.openResearchEvidence(root, id, path),
      open: (id, origin) => this.openEvidence(id, path, origin), error: error => this.hooks.notify(errorText(error), true),
    }, position));
    placeReaderFigure(view, holder);
  }

  async openEvidence(id: string, sourceDocument?: string, origin?: HTMLElement) {
    const root = this.hooks.root();
    if (root) await this.tools.evidence(root, id, sourceDocument, undefined, origin, Boolean(this.readerOpen && sourceDocument));
  }

  closeEvidence(focus = true) { return this.tools.closeEvidence(focus); }

  async openReference(id: string, origin?: HTMLButtonElement, back?: () => void) {
    const state = this.snapshot;
    if (!state) return;
    const request = ++this.referenceRequest;
    const record = state.records.find(item => item.record.id === id)?.record;
    if (record?.comparison) {
      const document = await window.meki.readResearchRecord(state.root, id);
      if (request !== this.referenceRequest || this.hooks.root() !== state.root) return;
      this.comparisonViewer.show(state.root, document, {
        width: this.widths.comparison, back,
        evidence: (file, trigger) => this.tools.evidence(state.root, file, undefined, t("返回对比"), trigger),
        edit: () => this.hooks.open(state.root, id, origin, true),
        error: error => this.hooks.notify(errorText(error), true),
      });
      return;
    }
    if (state.documents.some(file => file.id === id && file.sourceId)) { await this.openEvidence(id, undefined, origin); return; }
    if (record && state.project.recordTypes.some(type => type.id === record.type && type.kind === 'event')
      && state.documents.some(file => file.sourceId && researchReportFormat(file.relativePath))) {
      const document = await window.meki.readResearchRecord(state.root, id);
      if (request !== this.referenceRequest || this.hooks.root() !== state.root || (origin && !origin.isConnected)) return;
      const files = reportReferences(document, state.documents);
      if (files.length) {
        this.tools.previewReports(state.root, files, origin, () => this.hooks.open(state.root, id, origin));
        return;
      }
    }
    await this.hooks.open(state.root, id, origin);
  }

  async showProjects() {
    const projects = await window.meki.listResearchProjects();
    if (this.projectPicker.open) return;
    this.projectPicker.innerHTML = `<div class="dialog-heading"><h2>${ht("科研项目")}</h2><form method="dialog"><button class="icon-button" aria-label="${ht("关闭")}">${icon('close', 16)}</button></form></div>
      ${projects.length ? `<ul class="research-project-list">${projects.map(project => `<li><button type="button" data-research-project="${escape(project.root)}"${project.root === this.root ? ' aria-current="true"' : ''}>
        ${icon('folder', 17)}<span><strong>${escape(project.title)}</strong><small>${escape(project.root)}</small></span></button></li>`).join('')}</ul>` : ''}
      <div class="research-picker-actions"><button type="button" class="primary-button" data-action="research-open-project">${ht("打开科研项目")}</button>
        <button type="button" class="secondary-button" data-action="research-demo">${ht("创建示例项目")}</button></div>`;
    this.projectPicker.showModal();
  }

  closeProjects() { if (this.projectPicker.open) this.projectPicker.close(); }

  async refresh() {
    if (!this.visible) return;
    const root = this.hooks.root();
    if (this.root !== root) {
      this.root = root;
      this.snapshot = null;
      this.signature = '';
      this.viewKey = this.phaseId = this.date = '';
      this.timelineRange = undefined;
      this.phasePage = 1;
      this.recordFilter = undefined;
      this.clearAxisDrag();
      this.positions.clear();
      this.phaseReading.clear();
      this.stageNavigation = false;
      this.tools.closeEvidence(false);
      this.readerWipes.clear();
      this.expandedPhaseGroups = new Set(['ongoing']);
      this.readerContexts.clear();
      this.content.scrollTop = 0;
    }
    if (this.axisDrag?.moving) return;
    const number = ++this.loadNumber;
    this.loading = Boolean(root) && !this.signature;
    if (!this.signature) this.render();
    try {
      const includeLinked = !this.snapshot || this.destination(this.snapshot).page === 'summaries';
      const snapshot = root ? await window.meki.researchSnapshot(this.recordFilter, includeLinked) : null;
      await this.controlsIdle;
      if (number !== this.loadNumber || root !== this.hooks.root() || this.axisDrag?.moving) return;
      const shown = snapshot && this.destination(snapshot).page !== 'summaries'
        ? { ...snapshot, linkedSummaries: undefined } : snapshot;
      const signature = JSON.stringify([shown, this.recordFilter]);
      const today = snapshot ? projectToday(snapshot.project.timezone) : '';
      this.loading = false;
      if (signature === this.signature && today === this.renderedDay) return;
      const previous = this.snapshot && this.destination(this.snapshot);
      this.signature = signature;
      this.snapshot = snapshot;
      if (snapshot && previous && this.destination(snapshot).key !== previous.key) {
        this.phaseId = this.date = '';
        this.timelineRange = undefined;
        this.phasePage = 1;
        this.content.scrollTop = 0;
      }
      if (!snapshot?.project.phases.some(phase => phase.id === this.phaseId)) this.phaseId = '';
      this.render();
    } catch (error) {
      await this.controlsIdle;
      if (number !== this.loadNumber || root !== this.hooks.root() || this.axisDrag?.moving) return;
      this.loading = false;
      this.snapshot = null;
      const message = errorText(error);
      if (this.signature !== message) { this.signature = message; this.render(message); }
    }
  }

  private releaseControl(pointerId?: number) {
    const press = this.controlPress;
    if (!press || (pointerId !== undefined && pointerId !== press.pointerId)) return;
    this.controlPress = undefined;
    // Let the native click run before a pending refresh replaces its button.
    setTimeout(press.release, 0);
  }

  private openRangePicker(range: ResearchRange, bounds: ResearchRange) {
    this.rangePicker.innerHTML = `<form>
      <div class="dialog-heading"><h2 id="research-range-picker-title">${ht("选择时间范围")}</h2>
        <button type="button" class="icon-button" data-research-cancel aria-label="${ht("取消")}">${icon('close', 15)}</button></div>
      <div class="research-form-grid">
        <label>${ht("开始日期")}<input name="start" type="date" min="${bounds.start}" max="${bounds.end}" value="${range.start}" required autofocus></label>
        <label>${ht("结束日期")}<input name="end" type="date" min="${bounds.start}" max="${bounds.end}" value="${range.end}" required></label>
      </div>
      <p class="research-form-error" role="alert"></p>
      <div class="research-actions"><button type="submit" class="primary-button">${ht("应用")}</button></div>
    </form>`;
    this.rangePicker.showModal();
  }

  private setTimelineRange(selection?: TimelineRange, focus?: string | false) {
    this.timelineRange = selection;
    const state = this.snapshot;
    const today = state && projectToday(state.project.timezone);
    const range = state && today && clipRange(resolveTimelineRange(selection, today), timelineBounds(state, today));
    if (range && this.date && !containsDay(range, this.date)) this.date = '';
    this.render();
    if (focus === false) return;
    const button = selection && 'id' in selection ? `[data-research-range-preset="${selection.id}"]` : '[data-research-range]';
    (this.content.querySelector<HTMLButtonElement>(focus || button) || this.content.querySelector<HTMLButtonElement>(button))?.focus({ preventScroll: true });
  }

  private setPhasePageSize(size: number | null) {
    this.phasePageSize = size;
    this.phasePage = 1;
    try { localStorage.setItem(pageSizeKey, size === null ? 'all' : String(size)); } catch { /* Display preferences are optional. */ }
    this.render();
    this.content.querySelector<HTMLInputElement>('#research-phase-page-size')?.focus({ preventScroll: true });
  }

  private async setRecordFilter(filter?: ResearchFilter) {
    this.recordFilter = filter;
    await this.refresh();
    this.content.querySelector<HTMLButtonElement>('[data-research-filter]')?.focus({ preventScroll: true });
  }

  private axisWindow() {
    if (!this.snapshot) return;
    const today = projectToday(this.snapshot.project.timezone);
    const bounds = timelineBounds(this.snapshot, today);
    const range = clipRange(resolveTimelineRange(this.timelineRange, today), bounds);
    const start = dayNumber(range.start);
    return { bounds, start, days: dayNumber(range.end) - start + 1 };
  }

  private moveAxis(action: string, anchor = 0.5, focus = true) {
    const viewport = this.axisWindow();
    if (!viewport) return;
    const { bounds, start, days } = viewport;
    const shift = Math.max(1, Math.round(days / 5));
    const size = action === 'in' ? Math.max(1, Math.floor(days * 2 / 3)) : action === 'out' ? Math.ceil(days * 3 / 2) : days;
    const next = action === 'prev' ? start - shift : action === 'next' ? start + shift : Math.round(start + (days - size) * anchor);
    const range = shiftRange(bounds, next, size);
    if (dayNumber(range.start) === start && dayNumber(range.end) === start + days - 1) return;
    this.setTimelineRange(range, focus ? `[data-research-axis-action="${action}"]:enabled` : false);
  }

  private updateAxisRange(next: ResearchRange) {
    const current = this.axisWindow();
    if (current && (dayNumber(next.start) !== current.start || dayNumber(next.end) !== current.start + current.days - 1)) {
      this.setTimelineRange(next, false);
    }
  }

  private moveOverviewHandle(event: KeyboardEvent, handle: RangeHandle) {
    if (this.axisDrag?.moving || this.hooks.blocked()) return;
    const viewport = this.axisWindow();
    if (!viewport) return;
    const extent = dayNumber(viewport.bounds.end) - dayNumber(viewport.bounds.start);
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: -extent, End: extent };
    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    this.updateAxisRange(datesForDays(adjustDays(viewport, handle, steps[event.key])));
  }

  private beginAxisDrag(event: PointerEvent) {
    if (event.button !== 0 || this.axisDrag || this.hooks.blocked()) return;
    const target = event.target as Element;
    const overview = target.closest<HTMLElement>('[data-research-overview]');
    const axis = overview || target.closest<HTMLElement>('[data-research-pan]');
    if (!axis || target.closest('button') || overview?.hasAttribute('data-single-day')) return;
    const viewport = this.axisWindow();
    const { left, width } = axis.getBoundingClientRect();
    if (!viewport || !width) return;
    const handle = target.closest<HTMLElement>('[data-research-overview-handle]')?.dataset.researchOverviewHandle as RangeHandle | undefined;
    const part = !overview ? 'axis' : !handle || (handle === 'move' && overview.hasAttribute('data-full-range')) ? 'draw' : handle;
    this.axisDrag = { ...viewport, part, left, width, pointerId: event.pointerId, x: event.clientX,
      y: event.clientY, clientX: event.clientX, moving: false };
  }

  private updateAxisDrag(event: PointerEvent) {
    const drag = this.axisDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.abs(event.clientX - drag.x);
    if (!drag.moving) {
      if (distance < 4 || distance < Math.abs(event.clientY - drag.y)) return;
      drag.moving = true;
      this.content.setPointerCapture(event.pointerId);
      this.content.classList.add('research-axis-panning');
    }
    drag.clientX = event.clientX;
    if (this.axisFrame) return;
    this.axisFrame = requestAnimationFrame(() => {
      this.axisFrame = 0;
      this.applyAxisDrag(drag, true);
    });
  }

  private applyAxisDrag(drag: AxisDrag, live = false) {
    const { part, bounds, start, days, width, left, x, clientX } = drag;
    const distance = (clientX - x) / width;
    if (part === 'axis') {
      this.updateAxisRange(shiftRange(bounds, start - Math.round(distance * days), days));
      return;
    }
    const first = dayNumber(bounds.start), last = dayNumber(bounds.end), total = last - first + 1;
    const delta = distance * total, point = first + (clientX - left) / width * total;
    const anchor = Math.max(first, Math.min(last, first + Math.floor((x - left) / width * total)));
    const next = part === 'draw' ? brushDays(anchor, Math.floor(point), first, last) : adjustDays(drag, part, Math.round(delta));
    this.updateAxisRange(datesForDays(next));

    if (!live) return;
    // Follow the pointer between days while the detailed timeline stays on whole dates.
    const visual = part === 'draw' ? brushDays(anchor, point - 0.5, first, last) : adjustDays(drag, part, delta);
    const rail = this.content.querySelector<HTMLElement>('[data-research-overview]')!;
    rail.dataset.dragPart = part === 'draw' ? 'move' : part;
    rail.style.setProperty('--drag-left', `${(visual.start - first) * 100 / total}%`);
    rail.style.setProperty('--drag-width', `${(visual.end - visual.start + 1) * 100 / total}%`);
  }

  private clearAxisDrag() {
    const drag = this.axisDrag;
    this.axisDrag = undefined;
    if (this.axisFrame) cancelAnimationFrame(this.axisFrame);
    this.axisFrame = 0;
    this.content.classList.remove('research-axis-panning');
    if (drag && drag.part !== 'axis') {
      const rail = this.content.querySelector<HTMLElement>('[data-research-overview]');
      if (rail) {
        delete rail.dataset.dragPart;
        rail.style.removeProperty('--drag-left');
        rail.style.removeProperty('--drag-width');
      }
    }
    if (drag && this.content.hasPointerCapture(drag.pointerId)) this.content.releasePointerCapture(drag.pointerId);
  }

  private finishAxisDrag(event?: PointerEvent) {
    const drag = this.axisDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    if (drag.moving && event?.type === 'pointerup') {
      drag.clientX = event.clientX;
      this.applyAxisDrag(drag);
    }
    this.clearAxisDrag();
    if (drag.moving) void this.refresh();
  }

  private async setGoal(index: number, done: boolean) {
    const state = this.snapshot, phase = state?.project.phases.find(phase => phase.id === this.phaseId);
    if (!state || !phase?.goals?.[index] || this.savingGoals) return;
    this.savingGoals = true;
    this.content.querySelectorAll<HTMLInputElement>('[data-research-goal]').forEach(input => { input.disabled = true; });
    const goals = phase.goals.map((goal, i) => i === index ? { ...goal, done } : goal);
    const phases = state.project.phases.map(item => item.id === phase.id ? { ...phase, goals } : item);
    try {
      await window.meki.configureResearchProject(state.root, { ifRevision: state.revision, project: { ...state.project, phases } });
    } catch (error) { this.hooks.notify(errorText(error), true); }
    finally {
      this.savingGoals = false;
      await this.refresh();
      if (this.snapshot?.root === state.root && this.phaseId === phase.id) {
        this.render();
        this.content.querySelector<HTMLElement>(`[data-research-goal="${index}"]`)?.focus({ preventScroll: true });
      }
    }
  }

  private destination(state: ResearchSnapshot) {
    const pages = destinations(state.project);
    return pages.find(page => page.key === this.viewKey)
      || pages.find(page => page.view?.id === state.project.defaultView) || pages[0];
  }

  private renderSidebar(state: ResearchSnapshot | null, active?: Destination) {
    const last = this.sidebarState;
    const reading = this.host.classList.contains('research-stage-reading');
    if (last && last.snapshot === state && last.page === active?.key && last.phase === this.phaseId && last.day === this.renderedDay && last.reading === reading) return;
    this.sidebarState = { snapshot: state, page: active?.key, phase: this.phaseId, day: this.renderedDay, reading };
    const navigation = state ? destinations(state.project) : [];
    const button = (item: Destination) => `<button type="button" data-research-destination="${escape(item.key)}" aria-label="${escape(item.label)}"
      ${item.view ? `data-research-view="${item.view.id}"` : ''} aria-current="${item.key === active?.key && !reading ? 'page' : 'false'}"
      aria-pressed="${item.key === active?.key}">${icon(item.glyph, 17)}<span>${escape(item.label)}</span></button>`;
    const group = (title: string, items: string) => items ? `<section class="research-nav-group" aria-label="${title}">
      <h2 class="research-nav-label">${title}</h2><div class="research-nav-list">${items}</div></section>` : '';
    const phases = state ? rankPhases(state.project.phases, state.records, this.renderedDay, state.project.recordTypes) : [];
    const listed = new Set(reading ? [...this.content.querySelectorAll<HTMLButtonElement>(peekItems)].map(item => item.dataset.researchRecord) : []);
    const stageRecords = listed.size && state ? `<div class="research-nav-records">${state.records.filter(item => listed.has(item.record.id))
      .sort((a, b) => sortEntries(b, a)).map(({ record }) => {
        const type = state.project.recordTypes.find(item => item.id === record.type);
        return `<button type="button" data-research-stage-record="${escape(record.id)}"
          title="${escape(record.title)}"${this.readerItem === '/' + record.id ? ' aria-current="page"' : ''}>${recordMark(recordKind(type, record), 13, type?.icon)}${escape(record.title)}</button>`;
      }).join('')}</div>` : '';
    const shelves = (['ongoing', 'ended', 'upcoming'] as const).map(status => {
      const items = phases.filter(item => item.group === status);
      if (!items.length) return '';
      const title = status === 'ongoing' ? ht("进行中") : status === 'ended' ? ht("已结束") : ht("未开始");
      return `<details class="research-phase-shelf" data-research-phase-group="${status}"${this.expandedPhaseGroups.has(status) ? ' open' : ''}>
        <summary>${icon('chevron', 12)}<span>${title}</span><small>${items.length}</small></summary>
        <div>${items.map(({ phase }) => `<button type="button" data-research-stage-link="${escape(phase.id)}"
          ${active?.page === 'timeline' && this.phaseId === phase.id ? 'aria-current="location"' : ''}>${escape(phase.title)}</button>${this.phaseId === phase.id ? stageRecords : ''}`).join('')}</div>
      </details>`;
    }).join('');
    const markup = `<button type="button" class="research-project-switch" data-action="research-projects" aria-haspopup="dialog" aria-label="${ht("切换科研项目")}">
        ${icon('folders', 17)}<span><small>${ht("科研项目")}</small><strong>${escape(state?.project.title || t("选择项目"))}</strong></span>${icon('down', 14)}
      </button>
      <div class="research-nav-scroll">
        ${group(ht("项目页面"), navigation.filter(item => !item.key.startsWith('view:') && item.page !== 'rules').map(button).join(''))}
        ${shelves ? group(ht("研究阶段"), `<button type="button" class="research-phase-rail" data-research-expand-phases aria-label="${ht("研究阶段")}"${reading ? ' aria-current="location"' : ''}>${icon('branch', 17)}</button>${shelves}`) : ''}
        ${group(ht("项目视图"), navigation.filter(item => item.key.startsWith('view:')).map(button).join(''))}
      </div>
      <div class="research-nav-bottom">${navigation.length ? button(navigation[navigation.length - 1]) : ''}
        <button type="button" data-action="research-close" aria-label="${ht("文稿编辑器")}">${icon('page', 17)}<span>${ht("文稿编辑器")}</span></button>
      </div>`;
    const scroll = this.sidebar.querySelector('.research-nav-scroll')?.scrollTop || 0;
    this.sidebar.innerHTML = markup;
    this.sidebar.querySelector('.research-nav-scroll')!.scrollTop = scroll;
  }

  private render(error?: string, revealPhase?: string) {
    const state = this.snapshot, active = state && this.destination(state);
    const focused = document.activeElement;
    const focusRoot = this.panel.contains(focused) ? this.panel : this.sidebar.contains(focused) ? this.sidebar : undefined;
    const focusKey = focusRoot && focused instanceof HTMLElement &&
      (focused instanceof HTMLButtonElement || focused.matches('summary[data-research-settings-section], summary[data-research-timeline-options], [data-research-overview-handle]')) && [...focused.attributes]
      .find(({ name }) => name.startsWith('data-research-') || name === 'data-action');
    const scroll = this.content.scrollTop;
    const today = state ? projectToday(state.project.timezone) : '';
    this.renderedDay = today;
    this.panel.dataset.width = this.widths.workspace;
    const expanded = !document.body.classList.contains('sidebar-hidden');
    const toggleLabel = expanded ? ht("收起侧栏") : ht("展开侧栏");
    const toggle = document.getElementById('window-caption') ? '' : `<button type="button" class="icon-button" data-action="sidebar" aria-label="${toggleLabel}" aria-controls="app-sidebar" aria-expanded="${expanded}" title="${toggleLabel}">${icon('layout', 17)}</button>`;
    const phaseCrumb = active?.page === 'timeline' && state?.project.phases.find(phase => phase.id === this.phaseId)?.title;
    this.toolbar.innerHTML = `<div class="research-breadcrumb">${toggle}${state ? `<span title="${escape(state.project.title)}">${escape(state.project.title)}</span><i aria-hidden="true">/</i>` : ''}
      <span>${escape(active?.label || t("科研项目"))}</span>${phaseCrumb ? `<i aria-hidden="true">/</i><span>${escape(phaseCrumb)}</span>` : ''}</div>
      ${state ? `<button type="button" class="icon-button" data-action="refresh" aria-label="${ht("刷新项目")}" title="${ht("刷新项目")}">${icon('refresh', 17)}</button>` : ''}`;
    if (!state || !active || !today) {
      this.samples.show();
      this.renderSidebar(state, active || undefined);
      this.timelineEvents.show();
      const message = error || (this.loading ? t("正在读取研究项目…") : t("打开项目后即可查看研究阶段、实验记录和阶段总结。"));
      this.content.innerHTML = `<div class="research-empty"><div><h1 tabindex="-1">${ht("科研项目")}</h1>
        <p${error ? ' role="alert"' : ''}>${escape(message)}</p></div>
        ${this.loading ? '' : `<div class="research-actions"><button type="button" class="primary-button" data-action="research-projects">${ht("打开科研项目")}</button>
          <button type="button" class="secondary-button" data-action="research-demo">${ht("创建示例项目")}</button></div>`}
      </div>`;
      return;
    }
    const { project, records, problems } = state;
    const view = active.view;
    const projectPage = active.page === 'timeline';
    const selection = projectPage ? this.timelineRange : undefined;
    const bounds = timelineBounds(state, today);
    const dateRange = projectPage ? clipRange(resolveTimelineRange(selection, today), bounds) : undefined;
    if (dateRange && this.date && !containsDay(dateRange, this.date)) this.date = '';
    const types = new Map(project.recordTypes.map(type => [type.id, type]));
    const summaryTypes = new Set(project.recordTypes.filter(type => type.kind === 'summary').map(type => type.id));
    const isSummary = ({ record }: ResearchEntry) => summaryTypes.has(record.type) || Boolean(record.coverage);
    const isEvent = ({ record }: ResearchEntry) => Boolean(record.comparison) || types.get(record.type)?.kind === 'event';
    const isExperiment = (item: ResearchEntry) => !isSummary(item) && !isEvent(item);
    const phases = project.phases.filter(phase => !view?.phaseIds || view.phaseIds.includes(phase.id));
    const summaries = records.filter(isSummary);
    const experiments = records.filter(isExperiment);
    const inView = records.filter(({ record }) => (!view?.typeIds || view.typeIds.includes(record.type)) &&
      (!view?.phaseIds || (record.phaseId && view.phaseIds.includes(record.phaseId))));
    const eventsByPhase = groupByPhase(inView.filter(isEvent));
    const phase = phases.find(item => item.id === this.phaseId);
    if (!phase) this.phaseId = '';
    const sequence = active.page === 'summaries' ? inView.filter(isSummary) :
      active.page === 'view' ? inView : inView.filter(isExperiment);
    const matching = state.matchingIds && new Set(state.matchingIds);
    const matches = ({ record }: ResearchEntry) => !matching || matching.has(record.id);
    const acceptsDay = monthFilter(this.recordFilter);
    const dayInView = (entry: ResearchEntry) => latestActivity(entry, this.date || dateRange?.start, this.date || dateRange?.end, acceptsDay);
    const compareRows = (a: ResearchEntry, b: ResearchEntry) => dayInView(a).localeCompare(dayInView(b)) || a.record.id.localeCompare(b.record.id);
    const entries = projectPage && !phase ? [] : sequence.filter(item => (!phase || item.record.phaseId === phase.id) && dayInView(item) && matches(item))
      .sort((a, b) => view?.order === 'oldest' ? compareRows(a, b) : compareRows(b, a));
    const linkedSummaries = active.page === 'summaries' ? (state.linkedSummaries || [])
      .filter(({ record }) => !this.date || record.date === this.date)
      .sort((a, b) => view?.order === 'oldest' ? sortEntries(a, b) : sortEntries(b, a)) : [];
    const summariesByPhase = new Map(projectPage ? phases.map(phase => [phase.id,
      summaries.filter(({ record }) => summaryCoversPhase(record, phase, project.phases, today))]) : []);
    const progressByPhase = new Map(projectPage ? phases.map(phase => [phase.id,
      [...(summariesByPhase.get(phase.id) || []), ...(eventsByPhase.get(phase.id) || [])]]) : []);
    const timelineView = dateRange ? timeline(phases, sequence, progressByPhase, eventsByPhase, {
      activePhase: phase?.id || '', today, range: dateRange, bounds, selectedRange: Boolean(selection),
      presetId: selection && 'id' in selection ? selection.id : undefined, types,
      page: this.phasePage, pageSize: this.phasePageSize, revealPhase, canCreatePhase: !view?.phaseIds,
      canCreateEvent: project.recordTypes.some(type => type.kind === 'event'),
    }) : undefined;
    if (timelineView) this.phasePage = timelineView.page;
    const latestExperiment = phase && projectPage ? sequence.filter(item =>
      item.record.phaseId === phase.id && latestActivity(item, '', today) && item.excerpt && matches(item)
    ).sort((a, b) => comparePhaseProgress(b, a, project.recordTypes, today))[0] : undefined;
    const phaseTitle = phase ? `<h2 id="research-journal-title">${escape(phase.title)}</h2><p class="research-phase-range">${escape(phaseDates(phase, today))}</p>`
      : `<h2 id="research-journal-title">${active.page === 'summaries' ? ht("已归档总结") : ht("实验记录")} <span>${entries.length + linkedSummaries.length}</span></h2>`;
    const lastExperiment = experiments.reduce((latest, item) => {
      const day = latestActivity(item, '', today);
      return day > latest ? day : latest;
    }, '');
    const newEntry = project.recordTypes.some(type => type.kind === 'entry') ? `<button type="button" class="secondary-button" data-research-new="entry">${icon('plus', 14)}${ht("新建研究记录")}</button>` : '';
    const newSummary = summaryTypes.size ? `<button type="button" class="secondary-button" data-research-new="summary">${icon('plus', 14)}${ht("插入阶段总结")}</button>` : '';
    const previousMarkers = timelineView && !this.axisDrag?.moving ? this.timelineEvents.capture() : undefined;
    const optionsOpen = this.content.querySelector<HTMLDetailsElement>('.research-timeline-options')?.open;
    const stage = projectPage ? phase : undefined;
    const stageSummaries = stage ? (summariesByPhase.get(stage.id) || []).filter(matches) : [];
    const stageEvents = stage ? (eventsByPhase.get(stage.id) || []).filter(matches) : [];
    const comparisons = stageEvents.filter(entry => entry.record.comparison);
    const newComparison = stage ? `<button type="button" class="secondary-button" data-research-new="comparison">${icon('plus', 14)}${ht("新建可视化展示")}</button>` : '';
    const goals = stage ? this.renderPhaseGoals(stage, project.phaseGoals) : '';
    const featuredComparisons = new Set<string>();
    this.content.innerHTML = `
      <header class="research-overview"><div><h1 tabindex="-1">${escape(projectPage ? project.title : active.label)}</h1>
        ${projectPage && project.description ? `<p>${escape(project.description)}</p>` : ''}
        ${projectPage ? `<div class="research-overview-stats"><span>${ht("{0} 条实验", experiments.length)}</span><span>${ht("{0} 份阶段总结", summaries.length)}</span>
          ${lastExperiment ? `<span>${ht("最近实验 {0}", escape(lastExperiment))}</span>` : ''}</div>` : ''}
      </div>${projectPage && !phase ? `<div class="research-actions research-timeline-shortcuts">${newEntry}${newSummary}
        <button type="button" class="secondary-button" data-research-filter aria-haspopup="dialog" aria-pressed="${Boolean(this.recordFilter)}">${icon('search', 14)} ${ht("研究筛选")}</button></div>` : ''}</header>
      ${problems.length ? `<details class="research-problems"><summary>${ht("{0} 份文档无法读取", problems.length)}</summary><ul>${problems.map(item => `<li><code>${escape(item.file)}</code> · ${escape(item.message)}</li>`).join('')}</ul></details>` : ''}
      ${timelineView?.html || ''}
      ${active.page === 'rules' ? this.renderSettings(state) : active.page === 'sources' ? this.renderSources(state) :
      projectPage && !phase ? '' : `
        <section class="research-journal${stage ? ' research-stage-detail' : ''}" aria-labelledby="research-journal-title">
          <header><div class="research-section-heading"><div>${phaseTitle}</div>
            <div class="research-actions">${active.page === 'summaries' ? newSummary : newEntry}
              ${stage && !stageSummaries.length && !latestExperiment ? newSummary : ''}${stage && !comparisons.length ? newComparison : ''}
              ${stage ? `<button type="button" class="secondary-button" data-research-edit-phase="${stage.id}">${icon('settings', 14)}${ht("编辑阶段")}</button>` : ''}
              ${phase || this.date || this.recordFilter ? `<button type="button" class="secondary-button" data-research-clear>${ht("清除筛选")}</button>` : ''}</div>
          </div>
          ${stage?.description || goals ? `<div class="research-stage-context">
            ${stage?.description ? `<div class="research-phase-focus"><h3>${ht("本阶段要判断什么")}</h3><p>${escape(stage.description)}</p></div>` : ''}
            ${goals}</div>` : ''}</header>
          ${stage ? this.renderStageSummaries(stageSummaries, latestExperiment, newSummary, state, today, featuredComparisons) : ''}
          ${comparisons.length ? this.renderPhaseComparisons(comparisons, types, featuredComparisons, newComparison) : ''}
          ${this.renderPhaseEvents(stageEvents.filter(entry => !entry.record.comparison), types)}
          ${stage ? '<section class="research-stage-section" data-record-kind="entry" aria-labelledby="research-experiments-title">' : ''}
          <div class="research-record-filters">
            ${stage ? `<h3 id="research-experiments-title">${ht("实验记录")} <span>${entries.length}</span></h3>` : ''}
            <div class="research-filters"><button type="button" class="secondary-button" data-research-filter aria-haspopup="dialog" aria-pressed="${Boolean(this.recordFilter)}">${icon('search', 14)} ${ht("研究筛选")}</button>
              <label for="research-date">${ht("按日期筛选")}</label><input id="research-date" type="date" value="${escape(this.date)}"${dateRange ? ` min="${dateRange.start}" max="${dateRange.end}"` : ''}></div>
          </div>
          ${this.recordFilter ? `<p class="research-active-filter">${escape([
            this.recordFilter.query, this.recordFilter.month, ...(this.recordFilter.fields || []).map(({ field, value }) => `${this.filterFieldName(field, state)} = ${value}`),
          ].filter(Boolean).join(' · '))}</p>` : ''}
          ${entries.length ? this.renderEntries(entries, view, state, dayInView) : ''}
          ${linkedSummaries.length ? this.renderLinkedSummaries(linkedSummaries) : ''}
          ${entries.length || linkedSummaries.length ? '' : `<p class="research-empty-list">${ht("这个视图中没有符合条件的记录。")}</p>`}
          ${stage ? '</section>' : ''}
        </section>`}
    `;
    this.renderSidebar(state, active);
    if (optionsOpen) this.content.querySelector('.research-timeline-options')?.setAttribute('open', '');
    this.timelineEvents.show(timelineView?.eventDays, types, previousMarkers);
    this.samples.show(state);
    if (this.readerItem) {
      const [linkedProject, id] = this.readerItem.split('/');
      this.selectReaderItem(id, linkedProject, true);
    }
    this.content.scrollTop = scroll;
    if (focusKey) {
      const selector = focused instanceof HTMLButtonElement ? 'button:enabled' : 'summary, [data-research-overview-handle]';
      const replacement = focusKey.name === 'data-research-timeline-events' ? timelineEventButton(this.content, focusKey.value) :
        focusRoot?.querySelector<HTMLElement>(`:is(${selector})[${focusKey.name}="${CSS.escape(focusKey.value)}"]`);
      replacement?.focus({ preventScroll: true });
    }
  }

  private renderPhaseGoals(phase: ResearchPhase, mode: ResearchSnapshot['project']['phaseGoals']) {
    const goals = mode === 'hidden' ? [] : phase.goals || [];
    if (!goals.length) return '';
    const checklist = mode === 'checklist';
    return `<div class="research-phase-details">
      <h3>${ht("阶段目标")}${checklist ? `<span>${goals.filter(goal => goal.done).length}/${goals.length}</span>` : ''}</h3>
        <ul${checklist ? ' class="research-goal-checklist"' : ''}>${goals.map((goal, index) => checklist
          ? `<li><label><input type="checkbox" data-research-goal="${index}"${goal.done ? ' checked' : ''}${this.savingGoals ? ' disabled' : ''}> ${escape(goal.text)}</label></li>`
          : `<li>${escape(goal.text)}</li>`).join('')}</ul>
    </div>`;
  }

  private renderPhaseEvents(entries: ResearchEntry[], types: Map<string, ResearchType>) {
    if (!entries.length) return '';
    return `<section class="research-stage-section research-phase-summaries" data-record-kind="event" aria-labelledby="research-phase-events-title">
      <h3 id="research-phase-events-title">${ht("阶段事件")}</h3><ul>${entries.map(({ record }) =>
      `<li class="research-summary-item"><button type="button" data-research-record="${record.id}">${recordMark('event', 17, types.get(record.type)?.icon)}
      <span><strong>${escape(record.title)}</strong><small>${record.date} · ${escape(types.get(record.type)?.label || record.type)}</small></span>${icon('chevron', 14)}</button>
      <button type="button" class="icon-button research-summary-properties" data-research-edit="${record.id}" aria-label="${ht("编辑记录属性")}" title="${ht("编辑记录属性")}">${icon('settings', 15)}</button></li>`).join('')}</ul></section>`;
  }

  private renderStageSummaries(entries: ResearchEntry[], experiment: ResearchEntry | undefined, create: string, state: ResearchSnapshot, today: string, featuredComparisons: Set<string>) {
    if (!entries.length && !experiment) return '';
    const sorted = entries.sort((a, b) => sortEntries(b, a));
    const summary = sorted.find(item => item.record.date <= today && item.excerpt);
    const latest = experiment && (!summary || comparePhaseProgress(experiment, summary, state.project.recordTypes, today) > 0) ? experiment : summary;
    const row = (entry: ResearchEntry, featured = false) => {
      const { record, excerpt } = entry;
      const isExperiment = entry === experiment;
      const type = state.project.recordTypes.find(type => type.id === record.type);
      const kind = recordKind(type, record);
      return `<li class="research-summary-item" data-record-kind="${kind}">
      <button type="button" ${isExperiment ? 'data-research-progress-link' : 'data-research-record'}="${record.id}">
        ${featured ? '' : recordMark(kind, 17, type?.icon)}<span>${featured ? `<span class="research-finding-kind">${recordMark(kind, 15, type?.icon)}${escape(type?.label || record.type)}</span>` : ''}
          ${featured && excerpt ? `<strong class="research-progress-conclusion">${escape(excerpt)}</strong>` : ''}
          <strong class="research-summary-title">${escape(record.title)}</strong>
          ${!featured && excerpt ? `<span class="research-summary-lede">${escape(excerpt)}</span>` : ''}
          <small class="research-summary-dates">${record.coverage ? `<span>${ht("覆盖 {0}", escape(rangeText(record.coverage)))}</span>` : ''}<span>${isExperiment ? ht("实验日期 {0}", latestActivity(entry, '', today)) : ht("撰写于 {0}", escape(record.date))}</span></small></span>${icon('chevron', 14)}</button>
      ${isExperiment ? '' : `<button type="button" class="icon-button research-summary-properties" data-research-edit="${record.id}" aria-label="${ht("编辑记录属性")}" title="${ht("编辑记录属性")}">${icon('settings', 15)}</button>`}</li>`;
    };
    const others = sorted.filter(entry => entry !== latest);
    const progress = latest ? `<section class="research-stage-section research-phase-summaries research-progress" data-record-kind="${latest === experiment ? 'entry' : 'summary'}" aria-labelledby="research-progress-title">
      <div class="research-section-heading"><h3 id="research-progress-title">${ht("最新进展")}</h3>${create}</div>
      <ul class="research-progress-latest research-summary-list">${row(latest, true)}</ul>
    </section>${this.progressLinks(latest.record, state, featuredComparisons)}` : '';
    const archive = others.length ? `<section class="research-stage-section research-phase-summaries" data-record-kind="summary" aria-labelledby="research-phase-summaries-title">
      <div class="research-section-heading"><h3 id="research-phase-summaries-title">${latest && latest !== experiment ? ht("其他阶段总结") : ht("阶段总结")}</h3>${latest ? '' : create}</div>
      <ul class="research-summary-list">${others.map(entry => row(entry)).join('')}</ul></section>` : '';
    return progress + archive;
  }

  private progressLinks(record: ResearchEntry['record'], state: ResearchSnapshot, featuredComparisons: Set<string>) {
    const files = new Map(state.documents.map(file => [file.id, file]));
    const entries = new Map(state.records.map(item => [item.record.id, item]));
    const types = new Map(state.project.recordTypes.map(type => [type.id, type]));
    const refs = [...new Set([...(record.sources || []), ...(record.evidence || [])])].flatMap(id => files.get(id) || []);
    if (!refs.length) return '';
    const figure = refs.map(file => entries.get(file.id)?.record).find(item => item?.comparison);
    const trial = refs.map(file => entries.get(file.id)).find(item => item && recordKind(types.get(item.record.type), item.record) === 'entry');
    const table = refs.find(file => file.sourceId && /\.(?:csv|tsv)$/i.test(file.relativePath));
    const cards: string[] = [];
    if (figure) {
      const sample = comparisonSample(figure.comparison!);
      if (sample) {
        featuredComparisons.add(figure.id);
        const type = types.get(figure.type);
        cards.push(`<article class="research-proof-card" data-record-kind="comparison"><button type="button" class="research-proof-open" data-research-progress-link="${escape(figure.id)}">
          ${recordMark('comparison', 16, type?.icon)}<strong>${escape(figure.title)}</strong>${icon('chevron', 14)}</button>${sample}</article>`);
      }
    }
    if (table) cards.push(`<article class="research-proof-card research-proof-table" data-record-kind="file">
      <button type="button" class="research-proof-open" data-research-progress-link="${escape(table.id)}">${recordMark('file', 16, 'table')}<strong>${escape(table.title)}</strong>${icon('chevron', 14)}</button>
      <div class="research-sample-table" data-research-sample="${escape(table.id)}"></div></article>`);
    const links = refs.filter(file => !featuredComparisons.has(file.id) && file !== table && file.id !== trial?.record.id).map(file => {
      const item = entries.get(file.id)?.record;
      const type = item && types.get(item.type);
      const basename = file.relativePath.split('/').pop()!;
      const config = file.sourceId && /\.json$/i.test(basename);
      const glyph = config ? 'braces' : file.sourceId ? (researchReportFormat(file.relativePath) === 'pptx' ? 'presentation' : 'page') : type?.icon;
      return `<button type="button" data-research-progress-link="${escape(file.id)}" title="${escape(file.relativePath)}">${recordMark(recordKind(type, item), 14, glyph)}<span>${escape(file.title)}</span>${config && file.title !== basename ? `<code>${escape(basename)}</code>` : ''}</button>`;
    });
    return `<section class="research-stage-section" aria-labelledby="research-evidence-title">
      <h3 id="research-evidence-title">${ht("结论依据")}</h3><div class="research-progress-links">
      ${cards.length ? `<div class="research-proof-gallery">${cards.join('')}</div>` : ''}
      ${trial ? this.linkedExperiment(trial, types.get(trial.record.type), this.destination(state).view?.fieldIds) : ''}
      ${links.slice(0, 3).join('')}${links.length > 3 ? `<details><summary>${ht("其余 {0} 项", links.length - 3)}</summary><div>${links.slice(3).join('')}</div></details>` : ''}</div></section>`;
  }

  private linkedExperiment({ record, fieldOrigins }: ResearchEntry, type?: ResearchType, fieldIds?: string[]) {
    const measure = (fieldIds ?? Object.keys(record.fields)).find(id =>
      typeof record.fields[id] === 'number' && fieldOrigins?.[id]?.rule.type === 'number' && fieldOrigins[id].rule.unit);
    const rule = measure && fieldOrigins?.[measure]?.rule;
    return `<button type="button" class="research-proof-trial" data-record-kind="entry" data-research-progress-link="${escape(record.id)}">
      ${recordMark('entry', 15, type?.icon)}<span>${escape(type?.label || record.type)}</span> <time>${escape(record.date)}</time>
      <strong>${escape(record.title)}</strong>${measure && rule ? `<span class="research-proof-measure">${escape(rule.label)} <b>${escape(fieldValue(rule, record.fields[measure]))}</b></span>` : ''}${icon('chevron', 13)}</button>`;
  }

  private renderPhaseComparisons(entries: ResearchEntry[], types: Map<string, ResearchType>, featured: Set<string>, create: string) {
    return `<section class="research-stage-section research-phase-summaries" data-record-kind="comparison" aria-labelledby="research-phase-comparisons-title">
      <div class="research-section-heading"><h3 id="research-phase-comparisons-title">${ht("可视化展示")}</h3>
        ${create}</div>
      <ul>${entries.sort((a, b) => sortEntries(b, a)).map(({ record }) => `<li class="research-summary-item research-comparison-entry">
        <button type="button" data-research-record="${record.id}">${recordMark('comparison', 17, types.get(record.type)?.icon)}<span><strong>${escape(record.title)}</strong>
          <small>${escape(record.date)} · ${ht("{0} 行 × {1} 列", record.comparison!.rows.length, record.comparison!.columns.length)}</small></span>${icon('chevron', 14)}</button>
        <button type="button" class="icon-button research-summary-properties" data-research-edit="${record.id}" aria-label="${ht("编辑记录属性")}" title="${ht("编辑记录属性")}">${icon('settings', 15)}</button>
        ${featured.has(record.id) ? '' : comparisonSample(record.comparison!)}</li>`).join('')}</ul>
    </section>`;
  }

  private renderLinkedSummaries(entries: LinkedResearchSummary[]) {
    return `<section class="research-phase-summaries" aria-labelledby="research-linked-summaries-title">
      <h3 id="research-linked-summaries-title">${ht("跨项目总结")}</h3>
      <ul class="research-summary-list">${entries.map(({ project, record }) => `<li><button type="button" data-research-record="${record.id}" data-research-linked-project="${project.id}">
        ${recordMark('summary', 18)}<span><strong>${escape(record.title)}</strong>
        <small>${ht("原项目 {0}", escape(project.title))} · ${ht("撰写于 {0}", escape(record.date))}${record.coverage ? ` · ${ht("覆盖 {0}", escape(rangeText(record.coverage)))}` : ''}</small></span>${icon('chevron', 14)}</button></li>`).join('')}</ul>
    </section>`;
  }

  private renderSources(state: ResearchSnapshot) {
    const records = new Set(state.records.map(({ record }) => record.id));
    const sources = state.documents.filter(document => !document.sourceId && !records.has(document.id));
    const external = state.evidenceSources || [];
    return `${state.manifestFile.startsWith('.mekir/') ? `<section class="research-indexed-files research-source-folders">
      <div class="research-section-heading"><h2>${ht("只读来源")}</h2><button type="button" class="secondary-button" data-research-add-source>${icon('plus', 14)} ${ht("登记只读来源")}</button></div>
      ${external.length ? `<ul>${external.map(source => {
        const evidence = state.documents.filter(file => file.sourceId === source.id);
        return `<li><div class="research-source-folder"><div><strong>${escape(source.label)}</strong> <code>${source.id}</code>
          <small>${source.available ? escape(source.directory || '') : ht("来源目录待绑定")}</small></div>
          <div class="research-actions"><button type="button" class="secondary-button" data-research-bind-source="${source.id}">${ht("重新绑定目录")}</button>
            <button type="button" class="secondary-button" data-research-index-evidence="${source.id}"${source.available ? '' : ' disabled'}>${ht("登记证据")}</button>
            <button type="button" class="secondary-button" data-research-import="${source.id}"${source.available ? '' : ' disabled'}>${ht("预览导入归档")}</button></div></div>
          ${evidence.length ? `<details><summary>${ht("已索引 {0} 个文件", evidence.length)}</summary><ul class="research-evidence-index">${evidence.map(file => `<li>
            <button type="button" data-research-record="${file.id}"><span><strong>${escape(file.title)}</strong><small>${escape(file.relativePath)}</small></span></button>
            <button type="button" class="icon-button research-copy-evidence" data-research-copy-evidence="${file.id}" title="${ht("复制证据链接")}" aria-label="${ht("复制证据链接")}">${icon('link', 15)}</button></li>`).join('')}</ul></details>` : ''}</li>`;
      }).join('')}</ul>` : `<p class="research-empty-list">${ht("可登记论文仓库或实验归档目录，供记录引用。")}</p>`}</section>` : ''}
      <section class="research-indexed-files">
      ${sources.length ? `<ul>${sources.map(document => `<li><button type="button" data-research-record="${document.id}">${icon('page', 18)}
        <span><strong>${escape(document.title)}</strong><small>${escape(document.relativePath)}</small></span>${icon('chevron', 14)}</button></li>`).join('')}</ul>`
      : `<p class="research-empty-list">${ht("项目索引中还没有其他资料。")}</p>`}
      <button type="button" class="secondary-button" data-action="research-files">${ht("浏览项目文件")}</button>
    </section>`;
  }

  private filterFieldName(field: string, state: ResearchSnapshot) {
    if (field.startsWith('run.')) return runFields()[field.slice(4)] || field;
    return state.project.recordTypes.flatMap(type => type.fields).find(rule => rule.id === field)?.label || field;
  }

  private renderSettings({ project, root, manifestFile }: ResearchSnapshot) {
    const expanded = new Set([...this.content.querySelectorAll<HTMLElement>('details[open] > summary[data-research-settings-section]')]
      .map(summary => summary.dataset.researchSettingsSection));
    const open = (section: string) => expanded.has(section) ? ' open' : '';
    return `<section class="research-settings" aria-label="${ht("项目设置")}">
      <div class="research-settings-description">
        <div><h2>${ht("项目描述")}</h2><p>${escape(project.description || t("未填写"))}</p></div>
        <button type="button" class="secondary-button" data-research-edit-description aria-label="${ht("编辑项目描述")}">${icon('edit', 14)}${ht("编辑")}</button>
      </div>
      <button type="button" class="research-settings-link" data-research-settings>${icon('timeline', 16)}${ht("时间线设置")}${icon('chevron', 14)}</button>
      <button type="button" class="research-settings-link" data-research-event-types>${icon('calendar', 16)}${ht("事件类型")}${icon('chevron', 14)}</button>
      <details class="research-settings-panel research-rules"${open('rules')}>
        <summary data-research-settings-section="rules">${ht("项目规则")}</summary>
        <div class="research-settings-body">
          <p>${ht("字段和模板按记录类型定义。Agent 通过 {0} 读取当前规则。", 'describe')}</p>
          ${project.instructions?.length ? `<ul>${project.instructions.map(rule => `<li>${escape(rule)}</li>`).join('')}</ul>` : ''}
          ${project.recordTypes.map(type => `<details${open(`type-${type.id}`)}><summary data-research-settings-section="type-${type.id}">${escape(type.label)} <code>${type.id}</code></summary>
            ${type.description ? `<p>${escape(type.description)}</p>` : ''}
            ${type.fields.length ? `<ul>${type.fields.map(field => `<li>${escape(field.label)} <code>${field.id}</code> · ${escape(fieldRuleDetails(field))}</li>`).join('')}</ul>` : ''}
            <pre>${escape(type.template)}</pre></details>`).join('')}
        </div>
      </details>
      <details class="research-settings-panel"${open('location')}>
        <summary data-research-settings-section="location">${ht("项目位置")}</summary>
        <div class="research-settings-body">
          <dl class="research-settings-location">
            <dt>${ht("项目目录")}</dt><dd><code>${escape(root)}</code></dd>
            <dt>${ht("配置文件")}</dt><dd><code>${escape(manifestFile)}</code></dd>
            <dt>${ht("项目时区")}</dt><dd>${escape(project.timezone)}</dd>
          </dl>
          <button type="button" class="secondary-button" data-research-copy-root>${ht("复制项目路径")}</button>
        </div>
      </details>
    </section>`;
  }

  private renderEntries(entries: ResearchEntry[], view: ResearchView | undefined, state: ResearchSnapshot, dayInView: (entry: ResearchEntry) => string) {
    const byDate = new Map<string, ResearchEntry[]>();
    for (const item of entries) {
      const day = dayInView(item);
      const group = byDate.get(day);
      if (group) group.push(item);
      else byDate.set(day, [item]);
    }
    const titles = new Map(state.documents.map(({ id, title }) => [id, title]));
    return Array.from(byDate, ([date, items]) => `<div class="research-date-group">
      <time datetime="${date}">${escape(date)}</time>
      <ul>${items.map(({ record, issues, fieldOrigins, excerpt }) => {
        const type = state.project.recordTypes.find(item => item.id === record.type);
        const phase = state.project.phases.find(item => item.id === record.phaseId);
        const current = new Map(type?.fields.map(rule => [rule.id, rule]));
        const fields = [...new Set([...current.keys(), ...Object.keys(record.fields)])]
          .filter(id => Object.hasOwn(record.fields, id) && (!view?.fieldIds || view.fieldIds.includes(id)));
        const sources = [...new Set([...(record.sources || []), ...(record.evidence || [])])].filter(id => titles.has(id));
        return `<li class="research-entry">
          <div class="research-entry-title"><span class="research-entry-type" data-record-kind="${recordKind(type, record)}">${recordMark(recordKind(type, record), 13, type?.icon)}${escape(type?.label || record.type)}</span>
            ${record.run?.missing.includes('RUN.md') ? `<span class="research-entry-type" data-record-kind="warning">${recordMark('warning', 13)}${ht("待补报告")}</span>` : ''}
            <button type="button" data-research-record="${record.id}">${escape(record.title)}</button>
            <button type="button" class="research-edit" data-research-edit="${record.id}" title="${ht("编辑记录属性")}" aria-label="${ht("编辑记录属性")}">${icon('settings', 15)}</button>
          </div>
          ${type?.kind === 'entry' && excerpt && excerpt !== record.title ? `<p class="research-entry-conclusion">${escape(excerpt)}</p>` : ''}
          ${phase || record.coverage || fields.length ? `<div class="research-entry-meta">
            ${phase ? `<span>${escape(phase.title)}</span>` : ''}
            ${record.coverage ? `<span>${ht("覆盖 {0}", escape(rangeText(record.coverage)))}</span>` : ''}
            ${fields.map(id => {
              const rule = Object.hasOwn(fieldOrigins || {}, id) ? fieldOrigins![id].rule : undefined;
              return `<button type="button" data-research-field="${escape(id)}" data-field-record="${escape(record.id)}" title="${ht("字段口径")}">${escape(rule?.label || current.get(id)?.label || id)} <strong>${escape(fieldValue(rule, record.fields[id]))}</strong></button>`;
            }).join('')}
          </div>` : ''}
          ${sources.length ? `<div class="research-sources"><span>${ht("来源文档")}</span>${sources.map(id => `<button type="button" data-research-record="${id}">${escape(titles.get(id)!)}</button>`).join('')}</div>` : ''}
          ${issues.length ? `<p class="research-issues">${escape(issues.join(' '))}</p>` : ''}
        </li>`;
      }).join('')}</ul></div>`).join('');
  }

  private async openListRecord(button: HTMLButtonElement, root: string) {
    this.pendingListRecord = button;
    if (this.openingListRecord) return;
    this.openingListRecord = true;
    try {
      while (this.pendingListRecord && this.visible && this.root === root) {
        if (this.hooks.blocked()) {
          await this.hooks.whenIdle();
          if (this.hooks.blocked() || !this.visible || this.root !== root) break;
        }
        const next: HTMLButtonElement = this.pendingListRecord;
        this.pendingListRecord = undefined;
        const { researchRecord: id, researchLinkedProject: linked } = next.dataset;
        const origin = next.isConnected ? next : [...this.content.querySelectorAll<HTMLButtonElement>(peekItems)]
          .find(item => item.dataset.researchRecord === id && item.dataset.researchLinkedProject === linked);
        if (!id || !origin) continue;
        if (linked) await this.hooks.open(root, id, origin, false, linked);
        else await this.openReference(id, origin);
        if (document.querySelector('dialog[open]')) break;
      }
    } finally { this.openingListRecord = false; this.pendingListRecord = undefined; }
  }

  private async click(event: MouseEvent) {
    const target = event.target as Element;
    const button = target.closest<HTMLButtonElement>('button') || (target.closest('[data-research-track]')
      ? target.closest('.research-timeline-row')?.querySelector<HTMLButtonElement>('[data-research-phase]') : null);
    const state = this.snapshot;
    if (!button || !state) return;
    if (button.dataset.action === 'refresh') this.samples.show(state, true);
    if (button.dataset.researchStageRecord) {
      const item = [...this.content.querySelectorAll<HTMLButtonElement>(peekItems)].find(el => el.dataset.researchRecord === button.dataset.researchStageRecord);
      if (item) await this.openListRecord(item, state.root);
      return;
    }
    if (button.matches(peekItems)) {
      await this.openListRecord(button, state.root);
      return;
    }
    const data = button.dataset;
    if (this.hooks.blocked() && (data.researchProgressLink || data.researchTrialRecords || data.researchTimelineEvents)) {
      await this.hooks.whenIdle();
      if (!this.visible || !button.isConnected || this.snapshot !== state) return;
    }
    if (this.hooks.blocked()) return;
    if ('researchExpandPhases' in data) {
      this.hooks.expandNavigation();
      const selected = this.sidebar.querySelector<HTMLElement>('.research-phase-shelf[open] [aria-current="location"]');
      (selected || this.sidebar.querySelector<HTMLElement>('.research-phase-shelf summary'))?.focus();
      return;
    }
    if (data.researchField && data.fieldRecord) {
      await this.showFields(data.fieldRecord, state, button, data.researchField);
      return;
    }
    if (data.researchProgressLink) { await this.openReference(data.researchProgressLink, button); return; }
    const dayRecords = data.researchTimelineEvents || data.researchTrialRecords;
    if (dayRecords) {
      const ids = new Set(dayRecords.split(' '));
      const events = state.records.filter(({ record }) => ids.has(record.id)).sort(sortEntries);
      if (events.length === 1) await this.openReference(events[0].record.id, button);
      else if (events.length) {
        const types = new Map(state.project.recordTypes.map(type => [type.id, type]));
        const choose = () => this.tools.chooseTimelineEvents(data.date!, events, types, id => this.openReference(id, button, choose));
        choose();
      }
      return;
    }
    if (data.researchRecord) {
      if (data.researchLinkedProject) await this.hooks.open(state.root, data.researchRecord, button, false, data.researchLinkedProject);
      else await this.openReference(data.researchRecord, button);
      return;
    }
    if ('researchAddSource' in data) { this.tools.registerSource(state.root); return; }
    if (data.researchBindSource) { await this.tools.bind(state.root, data.researchBindSource); return; }
    if (data.researchIndexEvidence) { this.tools.registerEvidence(state.root, data.researchIndexEvidence); return; }
    if (data.researchImport) { await this.tools.importPreview(state.root, data.researchImport); return; }
    if (data.researchCopyEvidence) {
      await window.meki.writeClipboardText(`mekir:${data.researchCopyEvidence}`);
      this.hooks.notify(t("已复制证据链接"));
      return;
    }
    if ('researchFilter' in data) { this.tools.filter(state, this.recordFilter, filter => this.setRecordFilter(filter)); return; }
    if ('researchSettings' in data || 'researchEventTypes' in data) {
      await this.refresh();
      const latest = this.snapshot;
      if (!latest || latest.root !== state.root) return;
      const selector = 'researchSettings' in data ? '[data-research-settings]' : '[data-research-event-types]';
      const focus = () => this.content.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
      if ('researchEventTypes' in data) this.tools.editEventTypes(latest, focus);
      else this.tools.editTimelineSettings(latest, this.widths, widths => {
        this.widths = widths;
        try { localStorage.setItem(widthsKey, JSON.stringify(widths)); } catch { /* Display preferences are optional. */ }
        this.render();
      }, focus);
      return;
    }
    if ('researchEditDescription' in data) {
      await this.refresh();
      const latest = this.snapshot;
      if (latest?.root === state.root) this.tools.editDescription(latest, () => {
        this.content.querySelector<HTMLButtonElement>('[data-research-edit-description]')?.focus({ preventScroll: true });
      });
      return;
    }
    if ('researchNewPhase' in data || data.researchEditPhase) {
      await this.refresh();
      const latest = this.snapshot;
      if (!latest || latest.root !== state.root) return;
      const phase = latest.project.phases.find(item => item.id === data.researchEditPhase);
      if ('researchNewPhase' in data || phase) {
        const selector = phase ? `[data-research-edit-phase="${CSS.escape(phase.id)}"]` : '[data-research-new-phase]';
        this.tools.editPhase(latest, projectToday(latest.project.timezone), phase, () => {
          this.content.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
        });
      }
      return;
    }
    if (data.researchEdit || data.researchNew) {
      await this.refresh();
      const latest = this.snapshot;
      if (!latest || latest.root !== state.root || this.dialog.open) return;
      const entry = latest.records.find(item => item.record.id === data.researchEdit);
      const kind = data.researchNew as ResearchType['kind'] | undefined;
      if (entry || kind === 'comparison' || latest.project.recordTypes.some(type => type.kind === kind)) this.openForm(latest, kind, entry);
      return;
    }
    if ('researchCopyRoot' in data) {
      try {
        await window.meki.writeClipboardText(state.root);
        button.textContent = t("已复制项目路径");
      } catch (error) { button.textContent = errorText(error); }
      return;
    }
    if (data.researchDestination || data.researchStageLink) {
      const stage = data.researchStageLink;
      const from = this.destination(state).key;
      const to = stage ? 'timeline' : data.researchDestination!;
      const returnToList = this.readerOpen && from === to && stage === this.phaseId;
      if (this.readerOpen) {
        await this.hooks.closeReader();
        if (this.readerOpen || this.root !== state.root) return;
      }
      if (from === to && !stage) return;
      this.stageNavigation = Boolean(stage);
      if (from !== to) {
        this.positions.set(from, { phaseId: this.phaseId, date: this.date, scroll: this.content.scrollTop, page: this.phasePage, range: this.timelineRange });
        const position = this.positions.get(to);
        this.viewKey = to;
        this.phaseId = position?.phaseId || '';
        this.date = position?.date || '';
        this.phasePage = position?.page || 1;
        this.timelineRange = position?.range;
      }
      if (stage) {
        this.phaseId = stage;
        this.date = '';
      }
      this.render(undefined, stage);
      if (stage) {
        const shortcut = this.sidebar.querySelector<HTMLButtonElement>(`[data-research-stage-link="${CSS.escape(stage)}"]`);
        const last = this.phaseReading.get(stage);
        if (!returnToList && last && this.content.querySelector(`.research-journal [data-research-record="${CSS.escape(last)}"]`)) {
          await this.hooks.open(state.root, last, shortcut || undefined);
        } else {
          this.content.querySelector('.research-journal')?.scrollIntoView({ block: 'nearest' });
          shortcut?.focus({ preventScroll: true });
        }
        return;
      }
      this.content.scrollTop = this.positions.get(to)?.scroll || 0;
      if (this.destination(state).page === 'summaries') await this.refresh();
      this.sidebar.querySelector<HTMLButtonElement>(`[data-research-destination="${CSS.escape(to)}"]`)?.focus({ preventScroll: true });
    } else if (data.researchPhase) {
      this.stageNavigation = false;
      this.phaseId = this.phaseId === data.researchPhase ? '' : data.researchPhase;
      if (this.phaseId) {
        const shelf = this.sidebar.querySelector(`[data-research-stage-link="${CSS.escape(this.phaseId)}"]`)?.closest('details');
        if (shelf?.dataset.researchPhaseGroup) this.expandedPhaseGroups.add(shelf.dataset.researchPhaseGroup);
      }
      this.render();
      this.content.querySelector<HTMLButtonElement>(`[data-research-phase="${CSS.escape(data.researchPhase)}"]`)?.focus({ preventScroll: true });
    } else if ('researchClear' in data) {
      this.stageNavigation = false;
      this.date = this.phaseId = '';
      if (this.recordFilter) await this.setRecordFilter();
      else this.render();
      this.content.querySelector<HTMLInputElement>('#research-date')?.focus({ preventScroll: true });
    } else if ('researchRange' in data) {
      this.openRangePicker({ start: data.start!, end: data.end! }, timelineBounds(state, projectToday(state.project.timezone)));
    } else if (data.researchAxisAction) {
      this.moveAxis(data.researchAxisAction);
    } else if ('researchResetRange' in data) {
      this.setTimelineRange();
    } else if (data.researchRangePreset) {
      const preset = rangePresets.find(item => item.id === data.researchRangePreset);
      if (preset) this.setTimelineRange(preset);
    } else if ('researchAllPhases' in data) {
      this.setPhasePageSize(null);
    } else if (data.researchPhasePage) {
      this.phasePage += Number(data.researchPhasePage);
      this.render();
      const pager = this.content.querySelector('.research-phase-pages');
      const focus = pager?.querySelector<HTMLButtonElement>(`[data-research-phase-page="${data.researchPhasePage}"]:enabled`)
        || pager?.querySelector<HTMLButtonElement>('button:enabled');
      focus?.focus({ preventScroll: true });
    }
  }

  private openForm(state: ResearchSnapshot, kind?: ResearchType['kind'], original?: ResearchEntry) {
    const record = original?.record;
    this.editing = original;
    this.formProject = state;
    const { project } = state;
    const view = this.destination(state).view;
    const types = project.recordTypes.some(type => type.id === state.comparisonType.id) ? project.recordTypes : [...project.recordTypes, state.comparisonType];
    const available = record ? types.filter(type => (type.kind === 'comparison') === Boolean(record.comparison)) : types.filter(type => type.kind === kind);
    const type = record ? available.find(type => type.id === record.type) ?? available[0]
      : available.find(type => view?.typeIds?.includes(type.id)) ?? available[0];
    if (!type) throw new Error(t("当前项目没有适用的记录类型。"));
    const comparison = type.kind === 'comparison';
    const typeOptions = available.map(item => option(item.id, item.label, type.id));
    const targets = state.documents.filter(source => source.id !== record?.id);
    const sources = targets.filter(source => !source.sourceId || record?.sources?.includes(source.id))
      .sort((a, b) => Number(!a.date) - Number(!b.date) || (a.date || '').localeCompare(b.date || '') || a.title.localeCompare(b.title, getLocale()));
    const availableIds = new Set(sources.map(source => source.id));
    const missingSources = (record?.sources || []).filter(id => !availableIds.has(id));
    const projects = state.knownProjects || [];
    const unavailableProjects = (record?.relatedProjects || []).filter(id => !projects.some(project => project.id === id));
    this.dialog.innerHTML = `<form>
      <div class="dialog-heading"><h2>${escape(record ? t("编辑记录属性") : comparison ? t("新建可视化展示") : kind === 'summary' ? t("插入阶段总结") : kind === 'event' ? t("添加事件") : t("新建研究记录"))}</h2>
        <button type="button" class="icon-button" data-research-cancel aria-label="${ht("关闭") }">${icon('close', 15)}</button></div>
      <div class="research-form-grid">
        <label class="wide">${ht("记录标题")}<input name="title" required maxlength="240" value="${escape(record?.title || '')}" autofocus></label>
        <label>${ht("记录类型")}<select name="type"${record && project.recordTypes.some(item => item.id === record.type) ? ' disabled' : ''}>${typeOptions.join('')}</select>
          <small data-research-type-description></small></label>
        <label><span data-research-date-label></span><input name="date" type="date" required value="${escape(record?.date || (kind === 'summary' ? projectToday(project.timezone) : this.date || projectToday(project.timezone)))}"></label>
        <label class="wide">${ht("关联阶段")}<select name="phaseId">
          ${option('', t("未分配阶段"), record ? record.phaseId || '' : this.phaseId)}${project.phases.map(phase => option(phase.id, phase.title, record ? record.phaseId || '' : this.phaseId)).join('')}
        </select></label>
      </div>
      <div data-research-summary hidden>
        <div class="research-form-grid">
          <label>${ht("覆盖开始")}<input name="start" type="date" value="${escape(record?.coverage?.start || '')}"></label>
          <label>${ht("覆盖结束")}<input name="end" type="date" value="${escape(record?.coverage?.end || '')}"></label>
        </div>
        <fieldset class="research-project-choices">
          <legend>${ht("关联项目")}</legend>
          <div class="research-project-choice-list">
            <label><input type="checkbox" disabled checked><span>${escape(project.title)} <small>${ht("当前项目")}</small></span></label>
            ${projects.map(project => `<label title="${escape(project.root)}"><input type="checkbox" name="related-project" value="${project.id}"${record?.relatedProjects?.includes(project.id) ? ' checked' : ''}><span>${escape(project.title)} <small>${escape(project.root.split(/[\\/]/).filter(Boolean).at(-1) || project.root)}</small></span></label>`).join('')}
            ${unavailableProjects.map(id => `<label><input type="checkbox" name="related-project" value="${id}" checked><span>${ht("{0}（项目暂不可用）", escape(id))}</span></label>`).join('')}
          </div>
          ${projects.length ? '' : `<p class="research-empty-list">${ht("打开其他科研项目后，即可在这里选择要关联的项目。")}</p>`}
        </fieldset>
        <details class="research-source-choices"><summary>${ht("关联来源文档")}</summary>
          ${sources.map(source => `<label title="${escape(source.relativePath)}"><input type="checkbox" name="source" value="${source.id}"${record?.sources?.includes(source.id) ? ' checked' : ''}> ${source.date ? `<time>${source.date}</time> ` : ''}${escape(source.title)}</label>`).join('')}
          ${missingSources.map(id => `<label><input type="checkbox" name="source" value="${id}" checked> ${ht("{0}（文档暂不可用）", id)}</label>`).join('')}
        </details>
      </div>
      <div class="research-form-grid" data-research-fields></div>
      ${comparison ? `<section class="research-comparison-editor"><div data-research-grid></div>
        ${record ? '' : `<label class="research-comparison-caption-field">${ht("图注（Markdown）")}<textarea name="comparison-caption" rows="4"></textarea></label>`}</section>` : ''}
      <details class="research-related-form"><summary>${ht("原始证据与研究关系")}</summary>
        ${targets.some(target => target.sourceId) || record?.evidence?.length ? `<label>${ht("证据 ID")}
          <input name="evidence-ids" value="${escape(record?.evidence?.join(' ') || '')}" placeholder="${ht("多个 ID 用空格分隔")}" list="research-evidence-ids"></label>
          <datalist id="research-evidence-ids">${targets.filter(target => target.sourceId).map(target => option(target.id, target.title, '')).join('')}</datalist>` : ''}
        <datalist id="research-relation-targets">${targets.map(target => option(target.id, target.title, '')).join('')}</datalist>
        <div data-research-relations>${(record?.relations || []).map(relation => this.relationRow(relation)).join('')}</div>
        <button type="button" class="secondary-button" data-add-relation>${icon('plus', 14)} ${ht("添加研究关系")}</button>
      </details>
      <p class="research-form-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="secondary-button" data-research-cancel>${ht("取消")}</button>
        <button type="submit" class="primary-button">${escape(record ? t("保存属性") : comparison ? t("保存展示") : t("创建并编辑"))}</button></div>
    </form>`;
    this.comparisonGrid = comparison ? new ComparisonGridEditor(this.dialog.querySelector('[data-research-grid]')!, state.documents, record?.comparison) : undefined;
    this.renderFields();
    if (!record) this.fillCoverage();
    this.dialog.showModal();
  }

  private get form() { return this.dialog.querySelector<HTMLFormElement>('form')!; }
  private input<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) { return this.form.elements.namedItem(name) as T; }

  private relationRow(relation?: ResearchRelation) {
    return `<div class="research-relation-row">
      <select name="relation-kind" aria-label="${ht("关系类型")}">${Object.entries(relationLabels()).map(([kind, label]) => option(kind, label, relation?.kind || '')).join('')}</select>
      <input name="relation-target" aria-label="${ht("关联记录或证据 ID")}" placeholder="${ht("关联记录或证据 ID")}" value="${escape(relation?.target || '')}" list="research-relation-targets" maxlength="64">
      <button type="button" class="icon-button" data-remove-relation aria-label="${ht("移除研究关系")}">${icon('close', 14)}</button>
      <input name="relation-note" aria-label="${ht("采用依据或关系说明")}" placeholder="${ht("采用依据或关系说明")}" value="${escape(relation?.note || '')}" maxlength="1000">
    </div>`;
  }

  private selectedType() {
    const state = this.formProject!;
    return state.project.recordTypes.find(type => type.id === this.input('type').value) ?? state.comparisonType;
  }

  private fillCoverage() {
    if (this.selectedType().kind !== 'summary') return;
    const { project } = this.formProject!;
    const phase = project.phases.find(item => item.id === this.input('phaseId').value);
    if (!phase) return;
    const { start, end } = phaseSpan(phase, projectToday(project.timezone));
    this.input('start').value ||= start;
    this.input('end').value ||= end;
  }

  private renderFields() {
    const type = this.selectedType(), summary = type.kind === 'summary';
    const description = this.dialog.querySelector<HTMLElement>('[data-research-type-description]')!;
    description.textContent = type.description || '';
    description.hidden = !type.description;
    this.dialog.querySelector<HTMLElement>('[data-research-date-label]')!.textContent = summary ? t("撰写日期") : t("发生日期");
    this.dialog.querySelector<HTMLElement>('[data-research-summary]')!.hidden = !summary;
    this.input('phaseId').required = type.kind === 'comparison' || type.kind === 'event';
    for (const key of ['start', 'end']) this.input(key).required = summary;
    const record = this.editing?.record;
    const editingSameType = record?.type === type.id;
    this.dialog.querySelector<HTMLElement>('[data-research-fields]')!.innerHTML = type.fields.map(rule => {
      const value = record ? (Object.hasOwn(record.fields, rule.id) ? record.fields[rule.id] : undefined) : rule.default;
      return `<label><span>${escape(rule.label)}${rule.unit ? ` (${escape(rule.unit)})` : ''}</span>
        ${fieldControl(rule, value, !editingSameType)}${rule.description ? `<small>${escape(rule.description)}</small>` : ''}</label>`;
    }).join('');
    // Preserve historical values and missing fields when only other properties are edited.
    this.initialFieldValues.clear();
    if (editingSameType) for (const rule of type.fields) this.initialFieldValues.set(rule.id, this.input(`field-${rule.id}`).value);
  }

  private async submit() {
    if (this.submitting || !this.formProject || this.hooks.blocked()) return;
    const state = this.formProject, original = this.editing;
    const type = this.selectedType();
    const fields: Record<string, ResearchValue | null> = Object.create(null);
    for (const rule of type.fields) {
      const control = this.input(`field-${rule.id}`);
      if (control.value === this.initialFieldValues.get(rule.id)) continue;
      const value = rule.type === 'text' ? control.value.trim() : control.value;
      if (!original && rule.default !== undefined && value === String(rule.default)) continue;
      fields[rule.id] = !value ? null : rule.type === 'number' ? Number(value) : rule.type === 'boolean' ? value === 'true' : value;
    }
    const date = this.input('date').value;
    const id = original?.record.id ?? `record-${date}-${crypto.randomUUID().slice(0, 8)}`;
    const data = new FormData(this.form);
    const relatedProjects = type.kind === 'summary' ? data.getAll('related-project').map(String) : [];
    const evidence = [...new Set(String(data.get('evidence-ids') || '').trim().split(/\s+/).filter(Boolean))];
    const relationKinds = data.getAll('relation-kind') as ResearchRelation['kind'][];
    const relationNotes = data.getAll('relation-note').map(value => String(value).trim());
    const relations = data.getAll('relation-target').flatMap((value, i) => {
      const target = String(value).trim(), note = relationNotes[i];
      return target || note ? [{ kind: relationKinds[i], target, ...(note ? { note } : {}) }] : [];
    });
    const comparison = this.comparisonGrid?.value();
    const caption = data.get('comparison-caption');
    const write: ResearchBatch = { ifProjectRevision: state.revision, records: [{
      id, ifRevision: original?.revision ?? null, type: type.id, title: this.input('title').value.trim(), date,
      phaseId: this.input('phaseId').value || null, fields,
      ...(evidence.length || original?.record.evidence ? { evidence } : {}),
      ...(relations.length || original?.record.relations ? { relations } : {}),
      ...(relatedProjects.length || original?.record.relatedProjects ? { relatedProjects } : {}),
      ...(comparison ? { comparison } : {}),
      ...(typeof caption === 'string' && caption.trim() ? { body: caption } : {}),
      ...(type.kind === 'summary' ? {
        coverage: { start: this.input('start').value, end: this.input('end').value },
        sources: data.getAll('source').map(String),
      } : { coverage: null }),
    }] };
    const feedback = this.dialog.querySelector<HTMLElement>('.research-form-error')!;
    const submit = this.dialog.querySelector<HTMLButtonElement>('button[type=submit]')!;
    this.submitting = submit.disabled = true;
    feedback.textContent = '';
    try {
      await window.meki.writeResearchBatch(state.root, write);
      await this.refresh();
      this.dialog.close();
      if (!original && comparison) await this.openReference(id);
      else if (!original) await this.hooks.open(state.root, id, undefined, true);
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      this.submitting = submit.disabled = false;
    }
  }
}

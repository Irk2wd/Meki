import { getLocale, ht, t } from '../electron/i18n.mjs';
import { comparisonImages } from '../electron/research-comparison.mjs';
import type { LinkedResearchSummary, ResearchBatch, ResearchEntry, ResearchField, ResearchFilter, ResearchPhase, ResearchRange, ResearchRelation, ResearchSnapshot, ResearchType, ResearchValue, ResearchView } from '../shared/research';
import { icon } from './icons';
import { ComparisonGridEditor, ComparisonViewer } from './research-comparison';
import { escapeResearch as escape, relationLabels, researchOption as option, ResearchTools, runFields } from './research-tools';
import './research-workspace.css';

const errorText = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');
const sortEntries = (a: Pick<ResearchEntry, 'record'>, b: Pick<ResearchEntry, 'record'>) =>
  a.record.date.localeCompare(b.record.date) || a.record.id.localeCompare(b.record.id);
const rangeText = (range: ResearchRange) => `${range.start} – ${range.end}`;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
const isoDay = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
const formatDay = (day: number, year = false) => new Intl.DateTimeFormat(getLocale(), { year: year ? 'numeric' : undefined, month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(day * 86400000);
const containsDay = (range: ResearchRange, date: string) => range.start <= date && date <= range.end;
const overlaps = (a: ResearchRange, b: ResearchRange) => a.start <= b.end && b.start <= a.end;
const rangePresets = [
  { id: '7d', amount: 7, unit: 'days' },
  { id: '14d', amount: 14, unit: 'days' },
  { id: '1m', amount: 1, unit: 'months' },
  { id: '3m', amount: 3, unit: 'months' },
] as const;
type RangePreset = typeof rangePresets[number];
type TimelineRange = ResearchRange | RangePreset;
const pageSizeKey = 'mekir.research.phasesPerPage';
const defaultPageSize = 10;
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

function projectToday(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts();
  const value = (key: string) => parts.find(part => part.type === key)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function phaseSpan({ start, end }: ResearchPhase, today: string): ResearchRange {
  return { start, end: end ?? (today < start ? start : today) };
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

function fieldValue(rule: ResearchField, value: ResearchValue) {
  if (typeof value === 'boolean') return value ? t("是") : t("否");
  return rule.unit ? `${value} ${rule.unit}` : String(value);
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

function fieldRuleDetails(rule: ResearchField) {
  return [rule.type, rule.unit, rule.required ? t("必填") : t("可选字段"),
    rule.min === undefined ? undefined : t("最小值 {0}", rule.min),
    rule.max === undefined ? undefined : t("最大值 {0}", rule.max),
    rule.options && t("选项 {0}", rule.options.join(' / ')),
    rule.default === undefined ? undefined : t("新记录默认值 {0}", String(rule.default)),
    rule.description].filter(Boolean).join(' · ');
}
interface TimelineOptions {
  activePhase: string;
  today: string;
  range?: ResearchRange;
  presetId?: RangePreset['id'];
  page: number;
  pageSize: number | null;
  canCreatePhase: boolean;
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

function timeline(phases: ResearchPhase[], entries: ResearchEntry[], progressByPhase: Map<string, ResearchEntry[]>,
  { activePhase, today, range: selection, presetId, page: requestedPage, pageSize, canCreatePhase }: TimelineOptions) {
  const spans = phases.map(phase => ({ phase, span: phaseSpan(phase, today) }));
  const comparisons = [...progressByPhase.values()].flat().filter(({ record }) => record.comparison);
  const dates = [...spans.flatMap(({ span }) => [span.start, span.end]), ...[...entries, ...comparisons].map(({ record }) => record.date)].sort();
  const range = selection || { start: dates[0] || today, end: dates.at(-1) || today };
  const start = dayNumber(range.start), end = dayNumber(range.end), span = end - start + 1;
  const crossesYear = new Date(start * 86400000).getUTCFullYear() !== new Date(end * 86400000).getUTCFullYear();
  const position = (date: string, offset = 0) => (dayNumber(date) - start + offset) * 100 / span;
  const dot = (date: string, ended: boolean) => `<i class="research-timeline-dot${ended ? ' is-ended' : ''}" style="--point:${position(date, 0.5)}%"></i>`;
  const hasToday = containsDay(range, today);
  const ticks = [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(start + (end - start) * i / 4)))];
  const ordered = spans.filter(({ span }) => overlaps(span, range)).map(({ phase, span }) => {
    const assigned = entries.filter(({ record }) => record.phaseId === phase.id);
    const latest = [...assigned, ...(progressByPhase.get(phase.id) || [])]
      .reduce((date, { record }) => record.date > date ? record.date : date, '');
    const group: keyof typeof phaseGroupOrder = today < span.start ? 'upcoming' : today > span.end ? 'ended' : 'ongoing';
    return { phase, span, group, latest, assigned: assigned.filter(({ record }) => containsDay(range, record.date)) };
  }).sort((a, b) => {
    if (a.group !== b.group) return phaseGroupOrder[a.group] - phaseGroupOrder[b.group];
    if (a.group === 'ended') return b.span.end.localeCompare(a.span.end);
    if (a.group === 'upcoming') return a.span.start.localeCompare(b.span.start);
    return b.latest.localeCompare(a.latest);
  });
  const limit = pageSize ?? Math.max(1, ordered.length);
  const pageCount = Math.max(1, Math.ceil(ordered.length / limit));
  const page = Math.max(1, Math.min(requestedPage, pageCount));
  const phaseRows = ordered.slice((page - 1) * limit, page * limit).map(({ phase, span, group, latest, assigned }) => {
    const activity = new Map<string, boolean>();
    for (const { record } of assigned) {
      activity.set(record.date, (activity.get(record.date) ?? true) && experimentEnded(record, group === 'ended'));
    }
    const displays = new Map<string, string[]>();
    for (const { record } of progressByPhase.get(phase.id) || []) {
      if (!record.comparison || !containsDay(range, record.date)) continue;
      const titles = displays.get(record.date);
      if (titles) titles.push(record.title);
      else displays.set(record.date, [record.title]);
    }
    const markers = [...displays].sort(([a], [b]) => a.localeCompare(b)).map(([date, titles]) => {
      const label = titles.length === 1 ? ht("打开可视化展示 {0}", escape(titles[0])) : ht("{0} 的 {1} 条可视化展示", date, titles.length);
      return `<button type="button" class="research-timeline-comparison" style="--point:${position(date, 0.5)}%"
        data-research-comparison-phase="${phase.id}" data-date="${date}" aria-haspopup="dialog" aria-label="${label}" title="${label}">${icon('image', 14)}</button>`;
    }).join('');
    const left = Math.max(0, position(span.start)), right = Math.max(0, 100 - position(span.end, 1));
    const status = group === 'ongoing' ? ht("进行中") : group === 'ended' ? ht("已结束") : ht("未开始");
    return `<div class="research-timeline-row">
      <button type="button" class="research-timeline-label" data-research-phase="${phase.id}" aria-pressed="${activePhase === phase.id}">
        <strong>${escape(phase.title)} <span class="research-phase-status${group === 'ongoing' ? ' research-phase-ongoing' : ''}">${status}</span></strong>
        <small>${escape(phaseDates(phase, today, true))} · ${ht("{0} 条实验", assigned.length)}</small>${latest ? `<small>${ht("最近进展 {0}", escape(formatDay(dayNumber(latest), latest.slice(0, 4) !== today.slice(0, 4))))}</small>` : ''}</button>
      <div class="research-timeline-track"><span aria-hidden="true"><i class="research-timeline-bar" style="--left:${left}%;--right:${right}%"></i>${[...activity].map(([date, ended]) => dot(date, ended)).join('')}
        ${hasToday ? `<i class="research-today-line" style="--point:${position(today, 0.5)}%"></i>` : ''}</span>${markers}</div>
    </div>`;
  }).join('');
  const presetButtons = rangePresets.map(({ id, amount, unit }) => {
    const label = unit === 'days' ? ht("{0} 天", amount) : ht("{0} 个月", amount);
    const accessibleLabel = unit === 'days' ? ht("最近 {0} 天", amount) :
      amount === 1 ? ht("最近 1 个月") : ht("最近 {0} 个月", amount);
    return `<button type="button" data-research-range-preset="${id}" aria-pressed="${presetId === id}" aria-label="${accessibleLabel}" title="${accessibleLabel}">${label}</button>`;
  }).join('');
  const pager = `<div class="research-timeline-pagination">
    <div class="research-page-options"><label for="research-phase-page-size">${ht("每页阶段数")}</label>
      <input id="research-phase-page-size" type="number" min="1" step="1" value="${pageSize ?? ''}" placeholder="${ht("全部")}">
      ${pageSize !== null ? `<button type="button" class="text-button" data-research-all-phases>${ht("全部阶段")}</button>` : ''}
    </div>
    ${pageCount > 1 ? `<nav class="research-phase-pages" aria-label="${ht("研究阶段分页")}">
      <button type="button" class="icon-button" data-research-phase-page="-1" aria-label="${ht("上一页")}" title="${ht("上一页")}" aria-describedby="research-phase-page-number"${page === 1 ? ' disabled' : ''}>${icon('back', 16)}</button>
      <span id="research-phase-page-number" role="status">${ht("第 {0} 页，共 {1} 页", page, pageCount)}</span>
      <button type="button" class="icon-button" data-research-phase-page="1" aria-label="${ht("下一页")}" title="${ht("下一页")}" aria-describedby="research-phase-page-number"${page === pageCount ? ' disabled' : ''}>${icon('chevron', 16)}</button>
    </nav>` : ''}
  </div>`;
  const html = `<section class="research-timeline" aria-labelledby="research-range-title">
    <div class="research-section-heading"><h2 id="research-range-title">${ht("研究阶段")}</h2>
      <div class="research-actions"><div class="research-range-presets" role="group" aria-label="${ht("快捷时间范围")}">${presetButtons}</div>
        <button type="button" class="secondary-button" data-research-range data-start="${range.start}" data-end="${range.end}"
        title="${ht("选择时间范围")}"${selection ? ` aria-label="${ht("选择时间范围")} · ${escape(rangeText(range))}"` : ''}>${icon('timeline', 14)}${selection ? escape(rangeText(range)) : ht("选择时间范围")}</button>
        ${selection ? `<button type="button" class="secondary-button" data-research-reset-range>${ht("全部时段")}</button>` : ''}
        ${canCreatePhase ? `<button type="button" class="secondary-button" data-research-new-phase>${icon('plus', 14)}${ht("新建阶段")}</button>` : ''}</div>
    </div>
    ${phaseRows ? `<div class="research-timeline-meta"><div class="research-legend"><span>${ht("阶段时段")}</span><span class="research-key-point">${ht("实验日期")}</span>${hasToday ? `<span class="research-key-today">${ht("今天")}</span>` : ''}</div>${pager}</div>
    <div class="research-timeline-axis" aria-hidden="true"><span></span><div class="research-timeline-ruler"${span > 1 ? ` data-research-axis data-start="${start}" data-end="${end}" title="${ht("拖动刻度选取时间范围")}"` : ''}>
      ${ticks.map((day, i) => `<span class="${ticks.length === 1 ? '' : i === 0 ? 'first' : i === ticks.length - 1 ? 'last' : 'middle'}" style="--tick:${(day - start + 0.5) * 100 / span}%">${escape(formatDay(day, crossesYear))}</span>`).join('')}
    </div></div>${phaseRows}` : `<p class="research-empty-list">${ht("这个时段内没有研究阶段。")}</p>`}
  </section>`;
  return { html, page };
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
  })), { key: 'rules', label: t("项目设置"), glyph: 'settings', page: 'rules' }];
}

function summaryCoversPhase(record: ResearchEntry['record'], phase: ResearchPhase, phases: ResearchPhase[], today: string) {
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

interface Hooks {
  root(): string | undefined;
  blocked(): boolean;
  open(root: string, id: string, origin?: HTMLButtonElement, edit?: boolean, sourceProjectId?: string): Promise<void>;
  closeReader(): Promise<void>;
  openProject(root: string): Promise<void>;
  notify(message: string, error?: boolean): void;
}

interface ViewPosition { phaseId: string; date: string; scroll: number; page: number; range?: TimelineRange }
interface AxisBrush { axis: HTMLElement; pointerId: number; clientX: number }

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
  private axisBrush?: AxisBrush;
  private positions = new Map<string, ViewPosition>();
  private readerContexts = new Map<string, ResearchSnapshot>();
  private readerReturn?: { scroll: number; origin?: HTMLButtonElement };
  private loading = false;
  private loadNumber = 0;
  private editing: ResearchEntry | undefined;
  private formProject: ResearchSnapshot | null = null;
  private initialFieldValues = new Map<string, string>();
  private submitting = false;

  constructor(private host: HTMLElement, private sidebar: HTMLElement, private hooks: Hooks) {
    this.tools = new ResearchTools(() => this.refresh(), hooks.notify);
    this.panel.id = 'research-workspace';
    this.panel.hidden = true;
    this.toolbar.className = 'research-toolbar';
    this.content.className = 'research-content';
    this.panel.append(this.toolbar, this.content);
    this.host.prepend(this.panel);
    this.dialog.id = 'research-record-dialog';
    this.projectPicker.id = 'research-project-picker';
    this.rangePicker.id = 'research-range-picker';
    this.rangePicker.setAttribute('aria-labelledby', 'research-range-picker-title');
    document.body.append(this.dialog, this.projectPicker, this.rangePicker);
    for (const element of [this.sidebar, this.panel]) {
      element.addEventListener('click', event => { void this.click(event).catch(error => this.hooks.notify(errorText(error), true)); });
    }
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
      }
    });
    this.content.addEventListener('keydown', event => {
      const target = event.target as HTMLInputElement;
      if (event.key !== 'Enter' || event.isComposing || target.id !== 'research-phase-page-size') return;
      event.preventDefault();
      target.blur();
    });
    this.content.addEventListener('pointerdown', event => this.beginAxisBrush(event));
    this.content.addEventListener('pointermove', event => this.updateAxisBrush(event));
    this.content.addEventListener('pointerup', event => this.finishAxisBrush(event));
    this.content.addEventListener('lostpointercapture', event => {
      if (this.axisBrush?.pointerId === event.pointerId) this.clearAxisBrush();
    });
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
    await this.refresh();
    this.content.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }

  hide() {
    this.clearAxisBrush();
    this.closeReader(false);
    this.panel.hidden = this.sidebar.hidden = true;
    this.host.classList.remove('research-mode');
    this.host.closest('.shell')?.classList.remove('research-shell');
  }

  openReader(origin?: HTMLButtonElement) {
    this.readerReturn ??= { scroll: this.content.scrollTop, origin };
    this.host.classList.add('research-reader-open');
    this.panel.inert = true;
  }

  closeReader(focus = true) {
    const returning = this.readerReturn;
    if (!returning) return;
    this.readerReturn = undefined;
    this.host.classList.remove('research-reader-open');
    this.panel.inert = false;
    this.content.scrollTop = returning.scroll;
    if (focus) {
      const button = returning.origin;
      const id = button?.dataset.researchRecord;
      const linked = button?.dataset.researchLinkedProject;
      const origin = linked ? `[data-research-linked-project="${CSS.escape(linked)}"]` : ':not([data-research-linked-project])';
      const replacement = id ? this.content.querySelector<HTMLButtonElement>(`[data-research-record="${CSS.escape(id)}"]${origin}`) : null;
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
    return { title: reference.title, context: [sourceProject, phase?.title, type?.label || t("资料"), entry?.date,
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

  async openEvidence(id: string, sourceDocument?: string) {
    const root = this.hooks.root();
    if (root) await this.tools.evidence(root, id, sourceDocument);
  }

  async openReference(id: string, origin?: HTMLButtonElement) {
    const state = this.snapshot;
    if (!state) return;
    if (state.records.some(({ record }) => record.id === id && record.comparison)) {
      const document = await window.meki.readResearchRecord(state.root, id);
      if (this.hooks.root() !== state.root) return;
      this.comparisonViewer.show(state.root, document, {
        evidence: file => this.tools.evidence(state.root, file, undefined, t("返回对比")),
        edit: () => this.hooks.open(state.root, id, origin, true),
        error: error => this.hooks.notify(errorText(error), true),
      });
    } else if (state.documents.some(file => file.id === id && file.sourceId)) await this.openEvidence(id);
    else await this.hooks.open(state.root, id, origin);
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
      this.clearAxisBrush();
      this.positions.clear();
      this.readerContexts.clear();
      this.content.scrollTop = 0;
    }
    if (this.axisBrush) return;
    const number = ++this.loadNumber;
    this.loading = Boolean(root) && !this.signature;
    if (!this.signature) this.render();
    try {
      const includeLinked = !this.snapshot || this.destination(this.snapshot).page === 'summaries';
      const snapshot = root ? await window.meki.researchSnapshot(this.recordFilter, includeLinked) : null;
      if (number !== this.loadNumber || root !== this.hooks.root() || this.axisBrush) return;
      const signature = JSON.stringify([snapshot, this.recordFilter]);
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
      if (number !== this.loadNumber || root !== this.hooks.root() || this.axisBrush) return;
      this.loading = false;
      this.snapshot = null;
      const message = errorText(error);
      if (this.signature !== message) { this.signature = message; this.render(message); }
    }
  }

  private openRangePicker(range: ResearchRange) {
    this.rangePicker.innerHTML = `<form>
      <div class="dialog-heading"><h2 id="research-range-picker-title">${ht("选择时间范围")}</h2>
        <button type="button" class="icon-button" data-research-cancel aria-label="${ht("取消")}">${icon('close', 15)}</button></div>
      <div class="research-form-grid">
        <label>${ht("开始日期")}<input name="start" type="date" min="0001-01-01" max="9999-12-31" value="${range.start}" required autofocus></label>
        <label>${ht("结束日期")}<input name="end" type="date" min="0001-01-01" max="9999-12-31" value="${range.end}" required></label>
      </div>
      <p class="research-form-error" role="alert"></p>
      <div class="research-actions"><button type="submit" class="primary-button">${ht("应用")}</button></div>
    </form>`;
    this.rangePicker.showModal();
  }

  private setTimelineRange(selection?: TimelineRange) {
    this.timelineRange = selection;
    this.phasePage = 1;
    const range = this.snapshot && resolveTimelineRange(selection, projectToday(this.snapshot.project.timezone));
    if (range && this.date && !containsDay(range, this.date)) this.date = '';
    this.render();
    const button = selection && 'id' in selection ? `[data-research-range-preset="${selection.id}"]` : '[data-research-range]';
    this.content.querySelector<HTMLButtonElement>(button)?.focus({ preventScroll: true });
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

  private beginAxisBrush(event: PointerEvent) {
    const axis = (event.target as Element).closest<HTMLElement>('[data-research-axis]');
    if (!axis || event.button !== 0 || this.axisBrush || this.hooks.blocked()) return;
    this.axisBrush = { axis, pointerId: event.pointerId, clientX: event.clientX };
    axis.setPointerCapture(event.pointerId);
  }

  private updateAxisBrush(event: PointerEvent) {
    const brush = this.axisBrush;
    if (!brush || brush.pointerId !== event.pointerId) return;
    const bounds = brush.axis.getBoundingClientRect();
    const fraction = (x: number) => Math.max(0, Math.min(1, (x - bounds.left) / bounds.width));
    const left = fraction(Math.min(brush.clientX, event.clientX)), right = fraction(Math.max(brush.clientX, event.clientX));
    brush.axis.style.setProperty('--selection-left', `${left * 100}%`);
    brush.axis.style.setProperty('--selection-right', `${(1 - right) * 100}%`);
    return { left, right };
  }

  private finishAxisBrush(event: PointerEvent) {
    const brush = this.axisBrush;
    if (!brush || brush.pointerId !== event.pointerId) return;
    const selection = this.updateAxisBrush(event);
    this.clearAxisBrush();
    if (!selection || Math.abs(event.clientX - brush.clientX) < 4) return;
    const start = Number(brush.axis.dataset.start), end = Number(brush.axis.dataset.end);
    const dayAt = (fraction: number) => isoDay(Math.min(end, start + Math.floor(fraction * (end - start + 1))));
    this.setTimelineRange({ start: dayAt(selection.left), end: dayAt(selection.right) });
  }

  private clearAxisBrush() {
    this.axisBrush?.axis.style.removeProperty('--selection-left');
    this.axisBrush?.axis.style.removeProperty('--selection-right');
    this.axisBrush = undefined;
  }

  private destination(state: ResearchSnapshot) {
    const pages = destinations(state.project);
    return pages.find(page => page.key === this.viewKey)
      || pages.find(page => page.view?.id === state.project.defaultView) || pages[0];
  }

  private renderSidebar(state: ResearchSnapshot | null, active?: Destination) {
    const navigation = state ? destinations(state.project) : [];
    const button = (item: Destination) => `<button type="button" data-research-destination="${escape(item.key)}"
      ${item.view ? `data-research-view="${item.view.id}"` : ''} aria-current="${item.key === active?.key ? 'page' : 'false'}"
      aria-pressed="${item.key === active?.key}">${icon(item.glyph, 17)}<span>${escape(item.label)}</span></button>`;
    this.sidebar.innerHTML = `<button type="button" class="research-project-switch" data-action="research-projects" aria-haspopup="dialog" aria-label="${ht("切换科研项目")}">
        ${icon('folder', 17)}<span><small>${ht("科研项目")}</small><strong>${escape(state?.project.title || t("选择项目"))}</strong></span>${icon('down', 14)}
      </button>
      <div class="research-nav-list">${navigation.slice(0, 4).map(button).join('')}</div>
      ${navigation.length > 5 ? `<div class="research-nav-label">${ht("项目视图")}</div><div class="research-nav-list">${navigation.slice(4, -1).map(button).join('')}</div>` : ''}
      <div class="research-nav-bottom">${navigation.length ? button(navigation[navigation.length - 1]) : ''}
        <button type="button" data-action="research-close">${icon('page', 17)}<span>${ht("文稿编辑器")}</span></button>
      </div>`;
  }

  private render(error?: string) {
    const state = this.snapshot, active = state && this.destination(state);
    const scroll = this.content.scrollTop;
    const today = state ? projectToday(state.project.timezone) : '';
    this.renderedDay = today;
    const toggle = `<button type="button" class="icon-button" data-action="sidebar" aria-label="${ht("显示或隐藏侧栏")}" title="${ht("显示或隐藏侧栏")}">${icon('layout', 17)}</button>`;
    this.renderSidebar(state, active || undefined);
    this.toolbar.innerHTML = `<div>${toggle}<span>${escape(active?.label || t("科研项目"))}</span></div>
      ${state ? `<button type="button" class="icon-button" data-action="refresh" aria-label="${ht("刷新项目")}" title="${ht("刷新项目")}">${icon('refresh', 17)}</button>` : ''}`;
    if (!state || !active || !today) {
      const message = error || (this.loading ? t("正在读取研究项目…") : t("打开项目后即可查看研究阶段、实验记录和阶段总结。"));
      this.content.innerHTML = `<div class="research-empty"><h1 tabindex="-1">${ht("科研项目")}</h1>
        <p${error ? ' role="alert"' : ''}>${escape(message)}</p>
        ${this.loading ? '' : `<div class="research-actions"><button type="button" class="primary-button" data-action="research-projects">${ht("打开科研项目")}</button>
          <button type="button" class="secondary-button" data-action="research-demo">${ht("创建示例项目")}</button></div>`}
      </div>`;
      return;
    }
    const { project, records, problems } = state;
    const view = active.view;
    const projectPage = active.page === 'timeline';
    const selection = projectPage ? this.timelineRange : undefined;
    const dateRange = resolveTimelineRange(selection, today);
    const summaryTypes = new Set(project.recordTypes.filter(type => type.kind === 'summary').map(type => type.id));
    const isSummary = ({ record }: ResearchEntry) => summaryTypes.has(record.type) || Boolean(record.coverage);
    const isExperiment = (item: ResearchEntry) => !isSummary(item) && !item.record.comparison;
    const phases = project.phases.filter(phase => !view?.phaseIds || view.phaseIds.includes(phase.id));
    const phase = phases.find(item => item.id === this.phaseId && (!dateRange || overlaps(phaseSpan(item, today), dateRange)));
    if (!phase) this.phaseId = '';
    const summaries = records.filter(isSummary);
    const experiments = records.filter(isExperiment);
    const inView = records.filter(({ record }) => (!view?.typeIds || view.typeIds.includes(record.type)) &&
      (!view?.phaseIds || (record.phaseId && view.phaseIds.includes(record.phaseId))));
    const sequence = active.page === 'summaries' ? inView.filter(isSummary) :
      active.page === 'view' ? inView : inView.filter(isExperiment);
    const matching = state.matchingIds && new Set(state.matchingIds);
    const matches = ({ record }: ResearchEntry) => !matching || matching.has(record.id);
    const entries = sequence.filter(({ record }) => (!phase || record.phaseId === phase.id) &&
      (!this.date || record.date === this.date) && (!dateRange || containsDay(dateRange, record.date)))
      .filter(matches).sort((a, b) => view?.order === 'oldest' ? sortEntries(a, b) : sortEntries(b, a));
    const linkedSummaries = active.page === 'summaries' ? (state.linkedSummaries || [])
      .filter(({ record }) => !this.date || record.date === this.date)
      .sort((a, b) => view?.order === 'oldest' ? sortEntries(a, b) : sortEntries(b, a)) : [];
    const summariesByPhase = new Map(projectPage ? phases.map(phase => [phase.id,
      summaries.filter(({ record }) => summaryCoversPhase(record, phase, project.phases, today))]) : []);
    const comparisonsByPhase = new Map<string, ResearchEntry[]>();
    for (const entry of records) {
      const { record } = entry;
      if (!record.comparison || !record.phaseId) continue;
      const comparisons = comparisonsByPhase.get(record.phaseId);
      if (comparisons) comparisons.push(entry);
      else comparisonsByPhase.set(record.phaseId, [entry]);
    }
    const progressByPhase = new Map(projectPage ? phases.map(phase => [phase.id,
      [...(summariesByPhase.get(phase.id) || []), ...(comparisonsByPhase.get(phase.id) || [])]]) : []);
    const timelineView = projectPage ? timeline(phases, sequence, progressByPhase, {
      activePhase: phase?.id || '', today, range: dateRange, presetId: selection && 'id' in selection ? selection.id : undefined,
      page: this.phasePage, pageSize: this.phasePageSize, canCreatePhase: !view?.phaseIds,
    }) : undefined;
    if (timelineView) this.phasePage = timelineView.page;
    const phaseTitle = phase ? `<h2 id="research-journal-title">${escape(phase.title)}</h2><p class="research-phase-range">${escape(phaseDates(phase, today))}</p>`
      : `<h2 id="research-journal-title">${active.page === 'summaries' ? ht("已归档总结") : ht("实验记录")} <span>${entries.length + linkedSummaries.length}</span></h2>`;
    const lastExperiment = experiments.reduce((latest, { record }) => record.date > latest ? record.date : latest, '');
    const newEntry = project.recordTypes.some(type => type.kind === 'entry') ? `<button type="button" class="secondary-button" data-research-new="entry">${icon('plus', 14)}${ht("新建研究记录")}</button>` : '';
    const newSummary = summaryTypes.size ? `<button type="button" class="secondary-button" data-research-new="summary">${icon('plus', 14)}${ht("插入阶段总结")}</button>` : '';
    this.content.innerHTML = `
      <header class="research-overview"><div><h1 tabindex="-1">${escape(projectPage ? project.title : active.label)}</h1>
        ${projectPage ? `${project.description ? `<p>${escape(project.description)}</p>` : ''}
          <button type="button" class="text-button research-edit-description" data-research-edit-description>${icon('edit', 14)}${ht("编辑项目描述")}</button>` : ''}</div>
        ${projectPage ? `<div class="research-overview-stats"><span>${ht("{0} 条实验", experiments.length)}</span><span>${ht("{0} 份阶段总结", summaries.length)}</span>
          ${lastExperiment ? `<span>${ht("最近实验 {0}", escape(lastExperiment))}</span>` : ''}</div>` : ''}
      </header>
      ${problems.length ? `<details class="research-problems"><summary>${ht("{0} 份文档无法读取", problems.length)}</summary><ul>${problems.map(item => `<li><code>${escape(item.file)}</code> · ${escape(item.message)}</li>`).join('')}</ul></details>` : ''}
      ${timelineView?.html || ''}
      ${active.page === 'rules' ? this.renderRules(state) : active.page === 'sources' ? this.renderSources(state) : `
        <section class="research-journal" aria-labelledby="research-journal-title">
          <div class="research-section-heading"><div>${phaseTitle}</div>
            <div class="research-actions">${active.page === 'summaries' ? newSummary : newEntry}
              ${phase && projectPage ? `<button type="button" class="secondary-button" data-research-edit-phase="${phase.id}">${icon('settings', 14)}${ht("编辑阶段")}</button>` : ''}
              ${phase || this.date || this.recordFilter ? `<button type="button" class="secondary-button" data-research-clear>${ht("清除筛选")}</button>` : ''}</div>
          </div>
          ${phase && projectPage ? this.renderStageSummaries((summariesByPhase.get(phase.id) || []).filter(matches), newSummary) : ''}
          ${phase && projectPage ? this.renderPhaseComparisons((comparisonsByPhase.get(phase.id) || []).filter(matches)) : ''}
          ${projectPage && !phase && newSummary ? `<div class="research-summary-shortcut">${newSummary}</div>` : ''}
          <div class="research-record-filters">
            ${phase && projectPage ? `<h3>${ht("实验记录")} <span>${entries.length}</span></h3>` : ''}
            <div class="research-filters"><button type="button" class="secondary-button" data-research-filter aria-haspopup="dialog" aria-pressed="${Boolean(this.recordFilter)}">${icon('search', 14)} ${ht("研究筛选")}</button>
              <label for="research-date">${ht("按日期筛选")}</label><input id="research-date" type="date" value="${escape(this.date)}"${dateRange ? ` min="${dateRange.start}" max="${dateRange.end}"` : ''}></div>
          </div>
          ${this.recordFilter ? `<p class="research-active-filter">${escape([
            this.recordFilter.query, this.recordFilter.month, ...(this.recordFilter.fields || []).map(({ field, value }) => `${this.filterFieldName(field, state)} = ${value}`),
          ].filter(Boolean).join(' · '))}</p>` : ''}
          ${entries.length ? this.renderEntries(entries, view, state) : ''}
          ${linkedSummaries.length ? this.renderLinkedSummaries(linkedSummaries) : ''}
          ${entries.length || linkedSummaries.length ? '' : `<p class="research-empty-list">${ht("这个视图中没有符合条件的记录。")}</p>`}
        </section>`}
    `;
    this.content.scrollTop = scroll;
  }

  private renderStageSummaries(entries: ResearchEntry[], create: string) {
    return `<section class="research-phase-summaries" aria-labelledby="research-phase-summaries-title">
      <div class="research-section-heading"><h3 id="research-phase-summaries-title">${ht("阶段总结")}</h3>${create}</div>
      ${entries.length ? `<ul>${entries.sort((a, b) => sortEntries(b, a)).map(({ record }) => `<li class="research-summary-item"><button type="button" data-research-record="${record.id}">
        ${icon('report', 18)}<span><strong>${escape(record.title)}</strong>
          <small>${record.coverage ? ht("覆盖 {0}", escape(rangeText(record.coverage))) + ' · ' : ''}${ht("撰写于 {0}", escape(record.date))}</small></span>${icon('chevron', 14)}</button>
        <button type="button" class="icon-button research-summary-properties" data-research-edit="${record.id}" aria-label="${ht("编辑记录属性")}" title="${ht("编辑记录属性")}">${icon('settings', 15)}</button></li>`).join('')}</ul>`
        : `<p class="research-empty-list">${ht("这个阶段还没有总结。")}</p>`}
    </section>`;
  }

  private renderPhaseComparisons(entries: ResearchEntry[]) {
    return `<section class="research-phase-summaries" aria-labelledby="research-phase-comparisons-title">
      <div class="research-section-heading"><h3 id="research-phase-comparisons-title">${ht("可视化展示")}</h3>
        <button type="button" class="secondary-button" data-research-new="comparison">${icon('plus', 14)}${ht("新建可视化展示")}</button></div>
      ${entries.length ? `<ul>${entries.sort((a, b) => sortEntries(b, a)).map(({ record }) => `<li class="research-summary-item">
        <button type="button" data-research-record="${record.id}">${icon('image', 18)}<span><strong>${escape(record.title)}</strong>
          <small>${escape(record.date)} · ${ht("{0} 行 × {1} 列", record.comparison!.rows.length, record.comparison!.columns.length)}</small></span>${icon('chevron', 14)}</button>
        <button type="button" class="icon-button research-summary-properties" data-research-edit="${record.id}" aria-label="${ht("编辑记录属性")}" title="${ht("编辑记录属性")}">${icon('settings', 15)}</button></li>`).join('')}</ul>` : ''}
    </section>`;
  }

  private renderLinkedSummaries(entries: LinkedResearchSummary[]) {
    return `<section class="research-phase-summaries" aria-labelledby="research-linked-summaries-title">
      <h3 id="research-linked-summaries-title">${ht("跨项目总结")}</h3>
      <ul>${entries.map(({ project, record }) => `<li><button type="button" data-research-record="${record.id}" data-research-linked-project="${project.id}">
        ${icon('report', 18)}<span><strong>${escape(record.title)}</strong>
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

  private renderRules({ project, root, manifestFile }: ResearchSnapshot) {
    return `<section class="research-rules" aria-label="${ht("项目规则")}">
      <div><code>${escape(manifestFile)}</code> · ${escape(project.timezone)}
        <button type="button" class="secondary-button" data-research-copy-root>${ht("复制项目路径")}</button>
      </div>
      <p>${escape(root)}</p>
      <p>${ht("字段和模板按记录类型定义。Agent 通过 {0} 读取当前规则。", 'describe')}</p>
      ${project.instructions?.length ? `<ul>${project.instructions.map(rule => `<li>${escape(rule)}</li>`).join('')}</ul>` : ''}
      ${project.recordTypes.map(type => `<details><summary>${escape(type.label)} <code>${type.id}</code></summary>
        ${type.description ? `<p>${escape(type.description)}</p>` : ''}
        ${type.fields.length ? `<ul>${type.fields.map(field => `<li>${escape(field.label)} <code>${field.id}</code> · ${escape(fieldRuleDetails(field))}</li>`).join('')}</ul>` : ''}
        <pre>${escape(type.template)}</pre></details>`).join('')}
    </section>`;
  }

  private renderEntries(entries: ResearchEntry[], view: ResearchView | undefined, state: ResearchSnapshot) {
    const byDate = new Map<string, ResearchEntry[]>();
    for (const item of entries) {
      const group = byDate.get(item.record.date);
      if (group) group.push(item);
      else byDate.set(item.record.date, [item]);
    }
    const titles = new Map(state.documents.map(({ id, title }) => [id, title]));
    return Array.from(byDate, ([date, items]) => `<div class="research-date-group">
      <time datetime="${date}">${escape(date)}</time>
      <ul>${items.map(({ record, issues }) => {
        const type = state.project.recordTypes.find(item => item.id === record.type);
        const phase = state.project.phases.find(item => item.id === record.phaseId);
        const fields = type?.fields.filter(rule => (!view?.fieldIds || view.fieldIds.includes(rule.id)) && Object.hasOwn(record.fields, rule.id)) || [];
        const sources = [...new Set([...(record.sources || []), ...(record.evidence || [])])].filter(id => titles.has(id));
        return `<li class="research-entry">
          <div class="research-entry-title"><span class="research-entry-type${record.coverage ? ' summary' : ''}">${escape(type?.label || record.type)}</span>
            ${record.run?.missing.includes('RUN.md') ? `<span class="research-entry-type summary">${ht("待补报告")}</span>` : ''}
            <button type="button" data-research-record="${record.id}">${escape(record.title)}</button>
            <button type="button" class="research-edit" data-research-edit="${record.id}" title="${ht("编辑记录属性")}" aria-label="${ht("编辑记录属性")}">${icon('settings', 15)}</button>
          </div>
          ${phase || record.coverage || fields.length ? `<div class="research-entry-meta">
            ${phase ? `<span>${escape(phase.title)}</span>` : ''}
            ${record.coverage ? `<span>${ht("覆盖 {0}", escape(rangeText(record.coverage)))}</span>` : ''}
            ${fields.map(rule => `<span>${escape(rule.label)} <strong>${escape(fieldValue(rule, record.fields[rule.id]))}</strong></span>`).join('')}
          </div>` : ''}
          ${sources.length ? `<div class="research-sources"><span>${ht("来源文档")}</span>${sources.map(id => `<button type="button" data-research-record="${id}">${escape(titles.get(id)!)}</button>`).join('')}</div>` : ''}
          ${issues.length ? `<p class="research-issues">${escape(issues.join(' '))}</p>` : ''}
        </li>`;
      }).join('')}</ul></div>`).join('');
  }

  private async click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    const state = this.snapshot;
    if (!button || !state || this.hooks.blocked()) return;
    const data = button.dataset;
    if (data.researchComparisonPhase) {
      const comparisons = state.records.filter(({ record }) => record.comparison &&
        record.phaseId === data.researchComparisonPhase && record.date === data.date);
      if (comparisons.length === 1) await this.openReference(comparisons[0].record.id, button);
      else if (comparisons.length) this.tools.chooseComparison(data.date!, comparisons, id => this.openReference(id, button));
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
    if (data.researchDestination) {
      if (this.readerOpen) {
        await this.hooks.closeReader();
        if (this.readerOpen) return;
      }
      const from = this.destination(state).key;
      const to = data.researchDestination;
      if (from === to) return;
      this.positions.set(from, { phaseId: this.phaseId, date: this.date, scroll: this.content.scrollTop, page: this.phasePage, range: this.timelineRange });
      const position = this.positions.get(to);
      this.viewKey = to;
      this.phaseId = position?.phaseId || '';
      this.date = position?.date || '';
      this.phasePage = position?.page || 1;
      this.timelineRange = position?.range;
      this.render();
      this.content.scrollTop = position?.scroll || 0;
      if (this.destination(state).page === 'summaries') await this.refresh();
      this.sidebar.querySelector<HTMLButtonElement>(`[data-research-destination="${CSS.escape(to)}"]`)?.focus({ preventScroll: true });
    } else if (data.researchPhase) {
      this.phaseId = this.phaseId === data.researchPhase ? '' : data.researchPhase;
      this.render();
      this.content.querySelector<HTMLButtonElement>(`[data-research-phase="${CSS.escape(data.researchPhase)}"]`)?.focus({ preventScroll: true });
    } else if ('researchClear' in data) {
      this.date = this.phaseId = '';
      if (this.recordFilter) await this.setRecordFilter();
      else this.render();
      this.content.querySelector<HTMLInputElement>('#research-date')?.focus({ preventScroll: true });
    } else if ('researchRange' in data) {
      this.openRangePicker({ start: data.start!, end: data.end! });
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
      <div class="dialog-heading"><h2>${escape(record ? t("编辑记录属性") : comparison ? t("新建可视化展示") : kind === 'summary' ? t("插入阶段总结") : t("新建研究记录"))}</h2>
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
    this.input('phaseId').required = type.kind === 'comparison';
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

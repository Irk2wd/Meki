import { getLocale, ht, t } from '../electron/i18n.mjs';
import type { ResearchBatch, ResearchEntry, ResearchField, ResearchPhase, ResearchRange, ResearchSnapshot, ResearchType, ResearchValue, ResearchView } from '../shared/research';
import { icon } from './icons';
import './research-workspace.css';

const escape = (value: string | number | boolean) => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);
const errorText = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');
const sortEntries = (a: ResearchEntry, b: ResearchEntry) => a.record.date.localeCompare(b.record.date) || a.record.id.localeCompare(b.record.id);
const rangeText = (range: ResearchRange) => `${range.start} – ${range.end}`;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
const formatDay = (day: number, year = false) => new Intl.DateTimeFormat(getLocale(), { year: year ? 'numeric' : undefined, month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(day * 86400000);
const shortRange = (range: ResearchRange) => `${formatDay(dayNumber(range.start))} – ${formatDay(dayNumber(range.end))}`;

function projectToday(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts();
  const value = (key: string) => parts.find(part => part.type === key)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function option(value: string, label: string, selected: string) {
  return `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`;
}

function fieldValue(rule: ResearchField, value: ResearchValue) {
  if (typeof value === 'boolean') return value ? t("是") : t("否");
  return rule.unit ? `${value} ${rule.unit}` : String(value);
}

function fieldControl(rule: ResearchField, value: ResearchValue | undefined) {
  const name = `name="field-${rule.id}"${rule.required ? ' required' : ''}`;
  const text = value === undefined ? '' : String(value);
  if (rule.type === 'choice' || rule.type === 'boolean') {
    const options = rule.type === 'boolean'
      ? option('true', t("是"), text) + option('false', t("否"), text)
      : rule.options!.map(value => option(value, value, text)).join('');
    return `<select ${name}>${option('', t("未填写"), text)}${options}</select>`;
  }
  const number = rule.type === 'number' ? ` step="any"${rule.min === undefined ? '' : ` min="${rule.min}"`}${rule.max === undefined ? '' : ` max="${rule.max}"`}` : '';
  return `<input ${name} type="${rule.type}" value="${escape(text)}" maxlength="1000"${number}>`;
}

function timeline(phases: ResearchPhase[], entries: ResearchEntry[], activePhase: string) {
  const summaries = entries.filter(({ record }) => record.coverage);
  const days = [...phases.flatMap(phase => [phase.start, phase.end]), ...entries.map(({ record }) => record.date),
    ...summaries.flatMap(({ record }) => [record.coverage!.start, record.coverage!.end])].map(dayNumber);
  if (!days.length) return '';
  const start = Math.min(...days), end = Math.max(...days), span = end - start + 1;
  const crossesYear = new Date(start * 86400000).getUTCFullYear() !== new Date(end * 86400000).getUTCFullYear();
  const position = (value: string, offset = 0) => (dayNumber(value) - start + offset) * 100 / span;
  const bar = (range: ResearchRange) => `--left:${position(range.start)}%;--right:${100 - position(range.end, 1)}%`;
  const dot = (date: string) => `<i class="research-timeline-dot" style="--point:${position(date, 0.5)}%"></i>`;
  const ticks = [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(start + (end - start) * i / 4)))];
  const phaseRows = phases.map(phase => {
    const activity = [...new Set(entries.filter(({ record }) => record.phaseId === phase.id && !record.coverage).map(({ record }) => record.date))];
    return `<button type="button" class="research-timeline-row" data-research-phase="${phase.id}" aria-pressed="${activePhase === phase.id}">
      <span class="research-timeline-label"><strong>${escape(phase.title)}</strong><small>${escape(shortRange(phase))}</small></span>
      <span aria-hidden="true" class="research-timeline-track"><i class="research-timeline-bar" style="${bar(phase)}"></i>${activity.map(dot).join('')}</span>
    </button>`;
  }).join('');
  const summaryRows = summaries.sort(sortEntries).map(({ record }) => `<button type="button" class="research-timeline-row research-timeline-summary" data-research-record="${record.id}">
    <span class="research-timeline-label"><strong>${escape(record.title)}</strong><small>${escape(shortRange(record.coverage!))} · ${ht("撰写于 {0}", escape(formatDay(dayNumber(record.date))))}</small></span>
    <span aria-hidden="true" class="research-timeline-track"><i class="research-timeline-bar" style="${bar(record.coverage!)}"></i>${dot(record.date)}</span>
  </button>`).join('');
  return `<section class="research-timeline" aria-labelledby="research-range-title">
    <div class="research-section-heading"><h2 id="research-range-title">${ht("阶段与覆盖时段")}</h2>
      <div class="research-legend"><span class="research-key-phase">${ht("阶段")}</span><span class="research-key-summary">${ht("总结覆盖")}</span><span class="research-key-point">${ht("记录日期")}</span></div>
    </div>
    <div class="research-timeline-axis" aria-hidden="true"><span></span><div>
      ${ticks.map((day, i) => `<span class="${i === 0 ? 'first' : i === ticks.length - 1 ? 'last' : 'middle'}" style="--tick:${(day - start + 0.5) * 100 / span}%">${escape(formatDay(day, crossesYear))}</span>`).join('')}
    </div></div>
    ${phaseRows}${summaryRows}
  </section>`;
}

interface Hooks {
  root(): string | undefined;
  blocked(): boolean;
  open(root: string, id: string): Promise<void>;
}

export class ResearchWorkspace {
  private panel = document.createElement('section');
  private content = document.createElement('div');
  private dialog = document.createElement('dialog');
  private snapshot: ResearchSnapshot | null = null;
  private signature = '';
  private root: string | undefined;
  private viewId = '';
  private phaseId = '';
  private date = '';
  private loading = false;
  private loadNumber = 0;
  private rules = false;
  private editing: ResearchEntry | undefined;
  private formProject: ResearchSnapshot | null = null;
  private submitting = false;

  constructor(private host: HTMLElement, private hooks: Hooks) {
    this.panel.id = 'research-workspace';
    this.panel.hidden = true;
    this.panel.innerHTML = `<div class="research-titlebar">
      <button type="button" data-action="research-close" class="secondary-button">${icon('back', 14)}${ht("返回编辑器")}</button>
      <button type="button" data-action="folder" class="secondary-button">${icon('folder', 15)}${ht("打开文件夹…")}</button>
    </div>`;
    this.content.className = 'research-content';
    this.panel.append(this.content);
    this.host.append(this.panel);
    this.dialog.id = 'research-record-dialog';
    document.body.append(this.dialog);
    this.content.addEventListener('click', event => { void this.click(event); });
    this.content.addEventListener('change', event => {
      const target = event.target as HTMLInputElement;
      if (target.id === 'research-date') { this.date = target.value; this.render(); this.content.querySelector<HTMLInputElement>('#research-date')?.focus(); }
    });
    this.dialog.addEventListener('cancel', event => { if (this.submitting) event.preventDefault(); });
    this.dialog.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('[data-research-cancel]') && !this.submitting) this.dialog.close();
    });
    this.dialog.addEventListener('change', event => {
      const target = event.target as HTMLInputElement;
      if (target.name === 'type') this.renderFields();
      if (target.name === 'phaseId') this.fillCoverage();
    });
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
  }

  get visible() { return !this.panel.hidden; }

  async show() {
    this.panel.hidden = false;
    this.host.classList.add('research-mode');
    await this.refresh();
    this.content.querySelector<HTMLElement>('h1')?.focus();
  }

  hide() {
    this.panel.hidden = true;
    this.host.classList.remove('research-mode');
  }

  async refresh() {
    if (!this.visible) return;
    const root = this.hooks.root();
    if (this.root !== root) {
      this.root = root;
      this.snapshot = null;
      this.signature = '';
      this.viewId = this.phaseId = this.date = '';
      this.rules = false;
    }
    const number = ++this.loadNumber;
    this.loading = Boolean(root) && !this.signature;
    if (!this.signature) this.render();
    try {
      const snapshot = root ? await window.meki.researchSnapshot() : null;
      if (number !== this.loadNumber || root !== this.hooks.root()) return;
      const signature = JSON.stringify(snapshot);
      this.loading = false;
      if (signature === this.signature) return;
      this.signature = signature;
      this.snapshot = snapshot;
      if (this.phaseId && !snapshot?.project.phases.some(phase => phase.id === this.phaseId)) this.phaseId = '';
      this.render();
    } catch (error) {
      if (number !== this.loadNumber || root !== this.hooks.root()) return;
      this.loading = false;
      this.snapshot = null;
      const message = errorText(error);
      if (this.signature !== message) { this.signature = message; this.render(message); }
    }
  }

  private render(error?: string) {
    const state = this.snapshot;
    if (!state) {
      const message = error || (this.loading ? t("正在读取研究项目…") : t("打开包含 meki-project.json 的项目，或创建一个渲染研究示例。"));
      this.content.innerHTML = `<div class="research-empty"><h1 tabindex="-1">${ht("研究项目")}</h1>
        <p${error ? ' role="alert"' : ''}>${escape(message)}</p>
        ${this.loading ? '' : `<button type="button" class="primary-button" data-action="research-demo">${ht("创建渲染研究示例")}</button>`}
      </div>`;
      return;
    }
    const { project, records, problems } = state;
    const view = project.views.find(item => item.id === this.viewId) || project.views.find(item => item.id === project.defaultView)!;
    const inView = records.filter(({ record }) => (!view.typeIds || view.typeIds.includes(record.type)) &&
      (!view.phaseIds || (record.phaseId && view.phaseIds.includes(record.phaseId))));
    const viewPhases = project.phases.filter(phase => !view.phaseIds || view.phaseIds.includes(phase.id));
    const entries = inView.filter(({ record }) => (!this.phaseId || record.phaseId === this.phaseId) && (!this.date || record.date === this.date))
      .sort((a, b) => view.order === 'oldest' ? sortEntries(a, b) : sortEntries(b, a));
    const hasSummary = project.recordTypes.some(type => type.kind === 'summary');
    const hasEntry = project.recordTypes.some(type => type.kind === 'entry');
    this.content.innerHTML = `
      <div class="research-overview">
        <div><h1 tabindex="-1">${escape(project.title)}</h1>${project.description ? `<p>${escape(project.description)}</p>` : ''}</div>
        <div class="research-actions">${hasSummary ? `<button type="button" class="secondary-button" data-research-new="summary">${ht("插入阶段总结")}</button>` : ''}
          ${hasEntry ? `<button type="button" class="primary-button" data-research-new="entry">${icon('plus', 15)}${ht("新建研究记录")}</button>` : ''}</div>
      </div>
      <div class="research-navigation">
        <div class="research-views" role="group" aria-label="${ht("项目视图")}">
          ${project.views.map(item => `<button type="button" data-research-view="${item.id}" aria-pressed="${item.id === view.id}">${escape(item.label)}</button>`).join('')}
        </div>
        <button type="button" class="secondary-button" data-research-rules aria-expanded="${this.rules}">${ht("项目规则")}</button>
      </div>
      ${this.rules ? this.renderRules(state) : ''}
      ${problems.length ? `<details class="research-problems"><summary>${ht("{0} 份记录无法读取", problems.length)}</summary><ul>${problems.map(item => `<li><code>${escape(item.file)}</code> · ${escape(item.message)}</li>`).join('')}</ul></details>` : ''}
      ${view.layout === 'timeline' ? timeline(viewPhases, inView, this.phaseId) : ''}
      <section class="research-journal" aria-labelledby="research-journal-title">
        <div class="research-section-heading"><h2 id="research-journal-title">${ht("研究记录")} <span>${entries.length}</span></h2>
          <div class="research-filters">
            <label for="research-date">${ht("按日期筛选")}</label><input id="research-date" type="date" value="${escape(this.date)}">
            ${this.phaseId || this.date ? `<button type="button" class="secondary-button" data-research-clear>${ht("清除筛选")}</button>` : ''}
          </div>
        </div>
        ${this.phaseId ? `<p class="research-phase-filter">${ht("当前阶段")} · ${escape(project.phases.find(phase => phase.id === this.phaseId)!.title)}</p>` : ''}
        ${entries.length ? this.renderEntries(entries, view, state) : `<p class="research-empty-list">${ht("这个视图中没有符合条件的记录。")}</p>`}
      </section>`;
  }

  private renderRules({ project, root }: ResearchSnapshot) {
    return `<section class="research-rules" aria-label="${ht("项目规则")}">
      <div><code>meki-project.json</code> · ${escape(project.timezone)}
        <button type="button" class="secondary-button" data-research-copy-root>${ht("复制项目路径")}</button>
      </div>
      <p>${escape(root)}</p>
      ${project.instructions?.length ? `<ul>${project.instructions.map(rule => `<li>${escape(rule)}</li>`).join('')}</ul>` : ''}
      ${project.recordTypes.map(type => `<details><summary>${escape(type.label)} <code>${type.id}</code></summary>
        ${type.description ? `<p>${escape(type.description)}</p>` : ''}
        <ul>${type.fields.map(field => `<li>${escape(field.label)} <code>${field.id}</code> · ${escape(field.unit || field.type)}${field.required ? ` · ${ht("必填")}` : ''}${field.description ? ` · ${escape(field.description)}` : ''}</li>`).join('')}</ul>
        <pre>${escape(type.template)}</pre></details>`).join('')}
    </section>`;
  }

  private renderEntries(entries: ResearchEntry[], view: ResearchView, state: ResearchSnapshot) {
    const byDate = new Map<string, ResearchEntry[]>();
    for (const item of entries) {
      const group = byDate.get(item.record.date);
      if (group) group.push(item);
      else byDate.set(item.record.date, [item]);
    }
    const titles = new Map(state.records.map(({ record }) => [record.id, record.title]));
    return Array.from(byDate, ([date, items]) => `<div class="research-date-group">
      <time datetime="${date}">${escape(date)}</time>
      <ul>${items.map(({ record, issues }) => {
        const type = state.project.recordTypes.find(item => item.id === record.type);
        const phase = state.project.phases.find(item => item.id === record.phaseId);
        const fields = type?.fields.filter(rule => (!view.fieldIds || view.fieldIds.includes(rule.id)) && Object.hasOwn(record.fields, rule.id)) || [];
        const sources = (record.sources || []).filter(id => titles.has(id));
        return `<li class="research-entry">
          <div class="research-entry-title"><span class="research-entry-type${record.coverage ? ' summary' : ''}">${escape(type?.label || record.type)}</span>
            <button type="button" data-research-record="${record.id}">${escape(record.title)}</button>
            <button type="button" class="research-edit" data-research-edit="${record.id}" title="${ht("编辑记录属性")}" aria-label="${ht("编辑记录属性")}">${icon('settings', 15)}</button>
          </div>
          ${phase || record.coverage || fields.length ? `<div class="research-entry-meta">
            ${phase ? `<span>${escape(phase.title)}</span>` : ''}
            ${record.coverage ? `<span>${ht("覆盖 {0}", escape(rangeText(record.coverage)))}</span>` : ''}
            ${fields.map(rule => `<span>${escape(rule.label)} <strong>${escape(fieldValue(rule, record.fields[rule.id]))}</strong></span>`).join('')}
          </div>` : ''}
          ${sources.length ? `<div class="research-sources"><span>${ht("来源记录")}</span>${sources.map(id => `<button type="button" data-research-record="${id}">${escape(titles.get(id)!)}</button>`).join('')}</div>` : ''}
          ${issues.length ? `<p class="research-issues">${escape(issues.join(' '))}</p>` : ''}
        </li>`;
      }).join('')}</ul></div>`).join('');
  }

  private async click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    const state = this.snapshot;
    if (!button || !state || this.hooks.blocked()) return;
    const data = button.dataset;
    if (data.researchRecord) { await this.hooks.open(state.root, data.researchRecord); return; }
    if (data.researchEdit) {
      const entry = state.records.find(item => item.record.id === data.researchEdit);
      if (entry) this.openForm(state, undefined, entry);
      return;
    }
    if (data.researchNew) { this.openForm(state, data.researchNew as ResearchType['kind']); return; }
    if ('researchCopyRoot' in data) {
      try {
        await window.meki.writeClipboardText(state.root);
        button.textContent = t("已复制项目路径");
      } catch (error) { button.textContent = errorText(error); }
      return;
    }
    if (data.researchView) this.viewId = data.researchView;
    else if (data.researchPhase) this.phaseId = this.phaseId === data.researchPhase ? '' : data.researchPhase;
    else if ('researchClear' in data) { this.date = ''; this.phaseId = ''; }
    else if ('researchRules' in data) this.rules = !this.rules;
    else return;
    const stableTarget = button.getAttributeNames().find(name => name.startsWith('data-research-'));
    this.render();
    if (stableTarget) {
      const value = button.getAttribute(stableTarget);
      [...this.content.querySelectorAll<HTMLButtonElement>(`[${stableTarget}]`)].find(item => item.getAttribute(stableTarget) === value)?.focus();
    }
  }

  private openForm(state: ResearchSnapshot, kind?: ResearchType['kind'], original?: ResearchEntry) {
    const record = original?.record;
    this.editing = original;
    this.formProject = state;
    const { project } = state;
    const view = project.views.find(view => view.id === (this.viewId || project.defaultView));
    const available = project.recordTypes.filter(type => type.kind === kind);
    const type = record ? project.recordTypes.find(type => type.id === record.type) ?? project.recordTypes[0]
      : available.find(type => view?.typeIds?.includes(type.id)) ?? available[0];
    const typeOptions = (record ? project.recordTypes : available).map(item => option(item.id, item.label, type.id));
    this.dialog.innerHTML = `<form>
      <div class="dialog-heading"><h2>${escape(record ? t("编辑记录属性") : kind === 'summary' ? t("插入阶段总结") : t("新建研究记录"))}</h2>
        <button type="button" class="icon-button" data-research-cancel aria-label="${ht("关闭") }">${icon('close', 15)}</button></div>
      <div class="research-form-grid">
        <label class="wide">${ht("记录标题")}<input name="title" required maxlength="240" value="${escape(record?.title || '')}" autofocus></label>
        <label>${ht("记录类型")}<select name="type"${record && project.recordTypes.some(item => item.id === record.type) ? ' disabled' : ''}>${typeOptions.join('')}</select></label>
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
        <details class="research-source-choices"><summary>${ht("关联来源记录")}</summary>
          ${state.records.filter(item => item.record.id !== record?.id).sort(sortEntries).map(({ record: source }) => `<label><input type="checkbox" name="source" value="${source.id}"${record?.sources?.includes(source.id) ? ' checked' : ''}> <time>${source.date}</time> ${escape(source.title)}</label>`).join('')}
        </details>
      </div>
      <div class="research-form-grid" data-research-fields></div>
      <p class="research-form-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="secondary-button" data-research-cancel>${ht("取消")}</button>
        <button type="submit" class="primary-button">${escape(record ? t("保存属性") : t("创建并编辑"))}</button></div>
    </form>`;
    this.renderFields();
    if (!record) this.fillCoverage();
    this.dialog.showModal();
  }

  private get form() { return this.dialog.querySelector<HTMLFormElement>('form')!; }
  private input<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) { return this.form.elements.namedItem(name) as T; }

  private selectedType() {
    return this.formProject!.project.recordTypes.find(type => type.id === this.input('type').value)!;
  }

  private fillCoverage() {
    if (this.selectedType().kind !== 'summary') return;
    const phase = this.formProject!.project.phases.find(item => item.id === this.input('phaseId').value);
    if (!phase) return;
    this.input('start').value ||= phase.start;
    this.input('end').value ||= phase.end;
  }

  private renderFields() {
    const type = this.selectedType(), summary = type.kind === 'summary';
    this.dialog.querySelector<HTMLElement>('[data-research-date-label]')!.textContent = summary ? t("撰写日期") : t("发生日期");
    this.dialog.querySelector<HTMLElement>('[data-research-summary]')!.hidden = !summary;
    for (const key of ['start', 'end']) this.input(key).required = summary;
    const record = this.editing?.record;
    this.dialog.querySelector<HTMLElement>('[data-research-fields]')!.innerHTML = type.fields.map(rule => {
      const value = record ? (Object.hasOwn(record.fields, rule.id) ? record.fields[rule.id] : undefined) : rule.default;
      return `<label><span>${escape(rule.label)}${rule.unit ? ` (${escape(rule.unit)})` : ''}</span>
        ${fieldControl(rule, value)}${rule.description ? `<small>${escape(rule.description)}</small>` : ''}</label>`;
    }).join('');
  }

  private async submit() {
    if (this.submitting || !this.formProject || this.hooks.blocked()) return;
    const state = this.formProject, original = this.editing;
    const type = this.selectedType();
    const fields: Record<string, ResearchValue | null> = Object.create(null);
    for (const rule of type.fields) {
      const control = this.input(`field-${rule.id}`);
      const value = rule.type === 'text' ? control.value.trim() : control.value;
      fields[rule.id] = !value ? null : rule.type === 'number' ? Number(value) : rule.type === 'boolean' ? value === 'true' : value;
    }
    const date = this.input('date').value;
    const id = original?.record.id ?? `record-${date}-${crypto.randomUUID().slice(0, 8)}`;
    const write: ResearchBatch = { ifProjectRevision: state.revision, records: [{
      id, ifRevision: original?.revision ?? null, type: type.id, title: this.input('title').value.trim(), date,
      phaseId: this.input('phaseId').value || null, fields,
      ...(type.kind === 'summary' ? {
        coverage: { start: this.input('start').value, end: this.input('end').value },
        sources: new FormData(this.form).getAll('source').map(String),
      } : { coverage: null }),
    }] };
    const feedback = this.dialog.querySelector<HTMLElement>('.research-form-error')!;
    const submit = this.dialog.querySelector<HTMLButtonElement>('button[type=submit]')!;
    this.submitting = submit.disabled = true;
    feedback.textContent = '';
    try {
      await window.meki.writeResearchBatch(state.root, write);
      this.dialog.close();
      await this.refresh();
      if (!original) await this.hooks.open(state.root, id);
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      this.submitting = submit.disabled = false;
    }
  }
}

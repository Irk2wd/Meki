import { ht, t } from '../electron/i18n.mjs';
import eventIcons from '../electron/research-event-icons.json';
import type { ResearchDocument, ResearchEntry, ResearchEvidenceFile, ResearchField, ResearchFilter, ResearchGoalMode, ResearchImportPreview, ResearchPhase, ResearchReference, ResearchRelationKind, ResearchSearchLocator, ResearchSnapshot, ResearchType, ResearchValue, ResearchWidth } from '../shared/research';
import { icon } from './icons';
import { recordKind, recordMark } from './research-record-mark';
import { revealEvidenceLine } from './research-search-location';
import { ResearchReportPreview } from './research-report-preview';
import { showEvidenceTable } from './research-evidence-table';

export const escapeResearch = (value: string | number | boolean) => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

export const researchOption = (value: string, label: string, selected: string) =>
  `<option value="${escapeResearch(value)}"${value === selected ? ' selected' : ''}>${escapeResearch(label)}</option>`;
export const timelineIcon = (type?: ResearchType, comparison = false) =>
  type?.icon || (type?.kind === 'comparison' || (!type && comparison) ? 'image' : 'calendar');

export interface ResearchWidths { workspace: ResearchWidth; comparison: ResearchWidth }
const goalModes = ['hidden', 'list', 'checklist'] as const;

export function relationLabels(): Record<ResearchRelationKind, string> {
  return { retest: t("复测"), replaces: t("替代"), compares: t("候选对照"), 'paper-adopted': t("论文采用"), 'paper-version': t("论文版本") };
}

export function runFields(): Record<string, string> {
  return { id: t("运行 ID"), category: t("归档类别"), status: t("归档状态"), question: t("研究问题"), models: t("模型范围"),
    scene: t("场景"), method: t("方法"), camera: t("相机"), protocol: t("评测口径"), paper_version: t("论文版本"), conclusion: t("结论") };
}

const escape = escapeResearch;
export function fieldValue(rule: ResearchField | undefined, value: ResearchValue) {
  if (typeof value === 'boolean') return value ? t("是") : t("否");
  return rule?.unit ? `${value} ${rule.unit}` : String(value);
}

export function fieldRuleDetails(rule: ResearchField, includeDescription = true) {
  const kind = { text: t("文本"), number: t("数值"), boolean: t("是／否"), date: t("日期"), choice: t("枚举选项") };
  return [kind[rule.type], rule.unit, rule.required ? t("必填") : t("可选字段"),
    rule.min === undefined ? undefined : t("最小值 {0}", rule.min),
    rule.max === undefined ? undefined : t("最大值 {0}", rule.max),
    rule.options && t("选项 {0}", rule.options.join(' / ')),
    rule.default === undefined ? undefined : t("新记录默认值 {0}", String(rule.default)),
    includeDescription && rule.description].filter(Boolean).join(' · ');
}
const option = researchOption;
const closeButton = (label = ht("取消")) => `<button type="button" class="icon-button" data-tools-close aria-label="${label}" title="${label}">${icon('close', 16)}</button>`;
const heading = (title: string) => `<div class="dialog-heading"><h2 id="research-tools-title">${escape(title)}</h2>${closeButton()}</div>`;
const feedback = '<p class="research-form-error" role="alert"></p>';
interface EvidenceTab {
  id: string; title: string; body: HTMLElement; markup: string; reveal: () => void; origin?: HTMLElement;
  viewport: HTMLElement; scroll?: { left: number; top: number };
}

function evidenceContent(file: ResearchEvidenceFile) {
  const body = document.createElement('div');
  body.className = 'research-evidence-content';
  if (file.kind === 'image') {
    const image = document.createElement('img');
    image.src = `data:${file.mime};base64,${file.content}`;
    image.alt = file.title;
    body.append(image);
  } else if (file.kind === 'csv' || file.kind === 'tsv') {
    showEvidenceTable(body, file.content ?? '', file.kind === 'tsv' ? '\t' : ',', file.title);
  } else {
    const text = document.createElement(file.kind === 'text' ? 'pre' : 'p');
    text.textContent = file.content ?? t("可在原目录中查看此文件。");
    body.append(text);
  }
  return body;
}

export class ResearchTools {
  private dialog = document.createElement('dialog');
  private inspector = document.createElement('aside');
  private evidenceTabs = new Map<string, EvidenceTab>();
  private temporaryEvidenceId?: string;
  private displayedEvidence?: EvidenceTab;
  private evidenceRequest = 0;
  private evidenceReturn?: { origin?: HTMLElement; scroll: HTMLElement; before: number; opened: number };
  private report = new ResearchReportPreview();
  private submitting = false;

  constructor(reader: HTMLElement, private refresh: () => Promise<void>, private notify: (message: string, error?: boolean) => void) {
    this.inspector.id = 'research-evidence-inspector';
    this.inspector.hidden = true;
    this.inspector.setAttribute('aria-labelledby', 'research-inspector-title');
    reader.append(this.inspector);
    this.inspector.addEventListener('click', event => {
      const target = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!target) return;
      if (target.hasAttribute('data-tools-close')) this.closeEvidence();
      if (target.hasAttribute('data-evidence-expand')) {
        this.inspector.toggleAttribute('data-expanded');
        this.labelEvidenceSize();
      }
      if (target.dataset.evidenceTab) {
        ++this.evidenceRequest;
        this.selectEvidenceTab(this.evidenceTabs.get(target.dataset.evidenceTab)!, true);
      }
      if (target.dataset.evidencePin) {
        const tab = this.evidenceTabs.get(target.dataset.evidencePin)!;
        if (tab.id === this.temporaryEvidenceId) this.temporaryEvidenceId = undefined;
        else this.makeTemporary(tab);
        this.selectEvidenceTab(tab, false);
        this.inspector.querySelector<HTMLButtonElement>('[data-evidence-pin]')!.focus({ preventScroll: true });
      }
      if (target.dataset.dismissEvidence) {
        ++this.evidenceRequest;
        const ids = [...this.evidenceTabs.keys()], id = target.dataset.dismissEvidence;
        const active = this.inspector.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.evidenceTab;
        this.evidenceTabs.delete(id);
        if (id === this.temporaryEvidenceId) this.temporaryEvidenceId = undefined;
        const nextId = active === id ? ids[ids.indexOf(id) + 1] || ids[ids.indexOf(id) - 1] : active;
        const next = nextId && this.evidenceTabs.get(nextId);
        if (next) this.selectEvidenceTab(next, true);
        else this.closeEvidence();
      }
    });
    this.inspector.addEventListener('keydown', event => {
      const tab = (event.target as Element).closest<HTMLButtonElement>('[data-evidence-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      ++this.evidenceRequest;
      const tabs = [...this.evidenceTabs.values()], index = tabs.findIndex(item => item.id === tab.dataset.evidenceTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
      this.selectEvidenceTab(tabs[next], true);
    });
    this.dialog.id = 'research-tools-dialog';
    this.dialog.setAttribute('aria-labelledby', 'research-tools-title');
    document.body.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { if (this.submitting) event.preventDefault(); });
    this.dialog.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-tools-close]') && !this.submitting) this.dialog.close();
    });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.dialog.replaceChildren(); });
  }

  private show(content: string, className = '') {
    this.dialog.className = className;
    this.dialog.innerHTML = content;
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>('[autofocus]')?.focus({ preventScroll: true });
  }

  private submit(action: (data: FormData, submitter: HTMLElement | null) => Promise<void>) {
    const form = this.dialog.querySelector('form')!;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (this.submitting) return;
      this.submitting = true;
      const message = form.querySelector<HTMLElement>('[role="alert"]')!;
      const buttons = form.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
      buttons.forEach(button => { button.disabled = true; });
      message.textContent = '';
      try { await action(new FormData(form), event.submitter); }
      catch (error) { message.textContent = String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, ''); }
      finally { this.submitting = false; buttons.forEach(button => { button.disabled = false; }); }
    });
  }

  showFieldRules({ record, fieldOrigins, currentFields }: ResearchDocument, manifestFile: string, origin: HTMLElement, selected?: string) {
    const values = Object.entries(record.fields);
    const expanded = selected ?? (values.length === 1 ? values[0][0] : undefined);
    const rows = values.map(([id, value]) => {
      const captured = Object.hasOwn(fieldOrigins || {}, id) ? fieldOrigins![id] : undefined;
      const current = currentFields?.find(rule => rule.id === id);
      const same = current && captured && JSON.stringify(current, Object.keys(current).sort()) === JSON.stringify(captured.rule, Object.keys(captured.rule).sort());
      const describe = (rule: ResearchField) => `<span>${escape(rule.description || rule.label)}</span><small class="research-rule-constraints">${escape(rule.label)} · ${escape(fieldRuleDetails(rule, false))}</small>`;
      const archive = manifestFile === 'meki-project.json' ? 'records/.field-rules' : '.mekir/field-rules';
      return `<details class="research-rule-row" data-rule-id="${escape(id)}"${expanded === id ? ' open' : ''}>
        <summary><span>${escape(captured?.rule.label || current?.label || id)}</span><strong>${escape(fieldValue(captured?.rule, value))}</strong></summary>
        <dl><dt>${ht("记录采用的口径")}</dt><dd>${captured ? describe(captured.rule) : ht("写入时的定义未留存。")}</dd>
          ${captured ? `<dt>${ht("取值来源")}</dt><dd>${captured.source === 'default' ? ht("创建时的项目默认值") : ht("记录写入值")}</dd>` : ''}
          <dt>${ht("当前项目规则")}</dt><dd>${same ? ht("与记录采用的口径一致。") : current ? describe(current) : ht("当前记录类型已移除此字段。")}</dd></dl>
        <details class="research-rule-files"><summary>${ht("规则文件")}</summary><dl>
          ${captured && record.fieldRules ? `<dt>${ht("记录采用的口径")}</dt><dd><code>${archive}/${escape(record.fieldRules)}.json</code></dd>` : ''}
          <dt>${ht("当前项目规则")}</dt><dd><code>${escape(manifestFile)} · ${escape(record.type)} / ${escape(id)}</code></dd></dl></details>
      </details>`;
    });
    this.show(`<div class="dialog-heading"><div><h2 id="research-tools-title">${ht("字段口径")}</h2><small>${escape(record.title)}</small></div>${closeButton(ht("关闭"))}</div>${rows.join('')}`, 'research-field-rules');
    const first = this.dialog.querySelector<HTMLElement>(expanded ? 'details[open] summary' : 'summary');
    first?.focus();
    this.dialog.addEventListener('close', () => { if (!this.dialog.open && origin.isConnected) origin.focus({ preventScroll: true }); }, { once: true });
  }

  editDescription({ root, project, revision }: ResearchSnapshot, focus: () => void) {
    if (this.dialog.open) return;
    this.show(`<form>${heading(t("编辑项目描述"))}
      <div class="research-form-grid"><label class="wide"><span id="research-description-label">${ht("项目描述")}</span>
        <textarea name="description" rows="5" maxlength="2000" aria-labelledby="research-description-label" autofocus>${escape(project.description ?? '')}</textarea></label></div>
      ${feedback}<div class="research-actions">
        <button type="button" class="secondary-button" data-tools-close>${ht("取消")}</button>
        <button type="submit" class="primary-button">${ht("保存")}</button>
      </div></form>`);
    this.submit(async data => {
      const description = String(data.get('description')).trim();
      const updated = { ...project };
      if (description) updated.description = description;
      else delete updated.description;
      await window.meki.configureResearchProject(root, { ifRevision: revision, project: updated });
      await this.refresh();
      this.dialog.close();
      focus();
    });
  }

  chooseTimelineEvents(date: string, entries: ResearchEntry[], types: Map<string, ResearchType>, open: (id: string) => Promise<void>) {
    if (this.dialog.open) return;
    const comparisons = entries.every(({ record }) => record.comparison);
    const experiments = entries.every(({ record }) => types.get(record.type)?.kind === 'entry' && !record.comparison);
    const multipleDays = !experiments && entries.some(({ record }) => record.date !== entries[0].record.date);
    const title = experiments ? t("{0} 的实验记录", date) : comparisons ? t("{0} 的可视化展示", date) : t("{0} 的事件", date);
    this.show(`${heading(title)}
      <ul class="research-project-list">${entries.map(({ record }, index) => {
        const type = types.get(record.type);
        const label = type?.label || record.type;
        return `<li><button type="button" data-research-event-choice="${record.id}"${index === 0 ? ' autofocus' : ''}>
          ${recordMark(recordKind(type, record), 17, type?.icon)}<span><strong>${escape(record.title)}</strong>
          <small${multipleDays ? '' : ' aria-hidden="true"'}>${escape(multipleDays ? `${record.date} · ${label}` : label)}</small></span></button></li>`;
      }).join('')}</ul>`);
    this.dialog.querySelectorAll<HTMLButtonElement>('[data-research-event-choice]').forEach(button => {
      button.addEventListener('click', () => {
        this.dialog.close();
        void open(button.dataset.researchEventChoice!).catch(error => this.notify(String(error), true));
      });
    });
  }

  editTimelineSettings({ root, project, revision }: ResearchSnapshot, widths: ResearchWidths, saveWidths: (next: ResearchWidths) => void, focus: () => void) {
    if (this.dialog.open) return;
    const widthOptions = (selected: ResearchWidth) => option('comfort', t("舒适"), selected) + option('edge', t("贴边"), selected);
    const goalLabels = [t("隐藏"), t("仅列出"), t("可勾选")];
    this.show(`<form>${heading(t("时间线设置"))}
      <div class="research-form-grid">
        <label>${ht("页面宽度")}<select name="workspace" autofocus>${widthOptions(widths.workspace)}</select></label>
        <label>${ht("可视化弹窗宽度")}<select name="comparison">${widthOptions(widths.comparison)}</select></label>
        <label>${ht("阶段目标")}<select name="goals">${goalModes.map((mode, i) => option(mode, goalLabels[i], project.phaseGoals ?? 'list')).join('')}</select></label>
        <label>${ht("项目开始日期（可选）")}<input name="start" type="date" value="${escape(project.start || '')}"></label>
      </div>${feedback}<div class="research-actions">
        <button type="button" class="secondary-button" data-tools-close>${ht("取消")}</button>
        <button type="submit" class="primary-button">${ht("保存")}</button></div></form>`);
    this.submit(async data => {
      const phaseGoals = data.get('goals') as ResearchGoalMode;
      const start = String(data.get('start'));
      if (phaseGoals !== (project.phaseGoals ?? 'list') || start !== (project.start ?? '')) {
        const updated = { ...project, phaseGoals };
        if (start) updated.start = start;
        else delete updated.start;
        await window.meki.configureResearchProject(root, { ifRevision: revision, project: updated });
      }
      saveWidths({ workspace: data.get('workspace') as ResearchWidth, comparison: data.get('comparison') as ResearchWidth });
      await this.refresh();
      this.dialog.close();
      focus();
    });
  }

  editEventTypes({ root, project, revision, comparisonType }: ResearchSnapshot, focus: () => void) {
    if (this.dialog.open) return;
    const types = [...project.recordTypes.filter(type => type.kind === 'event' || type.kind === 'comparison')];
    const implicitComparison = !types.some(type => type.kind === 'comparison');
    if (implicitComparison) types.unshift(comparisonType);
    const iconLabel = (key: string) => t(eventIcons[key as keyof typeof eventIcons]);
    const preview = (key: string) => `${icon(key, 17)}<span>${escape(iconLabel(key))}</span>${icon('down', 14)}`;
    const row = (type: ResearchType) => `<div class="research-event-type-row" data-event-type="${type.id}" data-event-icon="${timelineIcon(type)}">
      <label>${ht("类型名称")}<input maxlength="240" required value="${escape(type.label)}"></label>
      <div class="research-event-type-icon"><span>${ht("图标")}</span>
        <button type="button" class="secondary-button" data-pick-event-icon aria-expanded="false" aria-label="${ht("选择图标")}">${preview(timelineIcon(type))}</button></div>
      <div class="research-event-icon-choices" role="group" aria-label="${ht("备选图标")}" hidden></div>
    </div>`;
    this.show(`<form>${heading(t("项目事件类型"))}
      <div class="research-event-type-list">${types.map(row).join('')}</div>
      <button type="button" class="secondary-button" data-add-event-type>${icon('plus', 14)} ${ht("添加类型")}</button>
      ${feedback}<div class="research-actions">
        <button type="button" class="secondary-button" data-tools-close>${ht("取消")}</button>
        <button type="submit" class="primary-button">${ht("保存")}</button></div></form>`, 'research-event-types-dialog');
    const form = this.dialog.querySelector('form')!;
    const list = form.querySelector('.research-event-type-list')!;
    const closePicker = (button: HTMLButtonElement) => {
      button.setAttribute('aria-expanded', 'false');
      button.closest('.research-event-type-row')!.querySelector<HTMLElement>('.research-event-icon-choices')!.hidden = true;
    };
    form.addEventListener('click', event => {
      const button = (event.target as Element).closest('button');
      if (!button || this.submitting) return;
      if ('addEventType' in button.dataset) {
        const type: ResearchType = { id: `event-${crypto.randomUUID()}`, label: '', kind: 'event', icon: 'calendar', fields: [], template: '# {{title}}\n' };
        types.push(type);
        list.insertAdjacentHTML('beforeend', row(type));
        list.lastElementChild?.querySelector('input')?.focus();
      } else if ('pickEventIcon' in button.dataset) {
        const opening = button.getAttribute('aria-expanded') === 'false';
        form.querySelectorAll<HTMLButtonElement>('[data-pick-event-icon][aria-expanded=true]').forEach(closePicker);
        if (!opening) return;
        const row = button.closest<HTMLElement>('.research-event-type-row')!;
        const choices = row.querySelector<HTMLElement>('.research-event-icon-choices')!;
        choices.innerHTML = Object.keys(eventIcons).map(key => `<button type="button" data-event-icon-option="${key}"
          aria-pressed="${key === row.dataset.eventIcon}">${icon(key, 18)}<span>${escape(iconLabel(key))}</span></button>`).join('');
        choices.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        choices.querySelector<HTMLElement>('[aria-pressed=true]')?.focus({ preventScroll: true });
      } else if (button.dataset.eventIconOption) {
        const row = button.closest<HTMLElement>('.research-event-type-row')!;
        const picker = row.querySelector<HTMLButtonElement>('[data-pick-event-icon]')!;
        row.dataset.eventIcon = button.dataset.eventIconOption;
        picker.innerHTML = preview(row.dataset.eventIcon);
        closePicker(picker);
        picker.focus({ preventScroll: true });
      }
    });
    this.submit(async () => {
      const edited = [...list.querySelectorAll<HTMLElement>('.research-event-type-row')].flatMap((row, i) => {
        const type = types[i], label = row.querySelector('input')!.value.trim(), glyph = row.dataset.eventIcon!;
        if (!label) throw new Error(t("请填写事件类型名称。"));
        if (implicitComparison && type === comparisonType && label === type.label && glyph === timelineIcon(type)) return [];
        return [{ ...type, label, icon: glyph }];
      });
      const changes = new Map(edited.map(type => [type.id, type]));
      const recordTypes = project.recordTypes.map(type => changes.get(type.id) ?? type);
      const existing = new Set(recordTypes.map(type => type.id));
      recordTypes.push(...edited.filter(type => !existing.has(type.id)));
      await window.meki.configureResearchProject(root, { ifRevision: revision, project: { ...project, recordTypes } });
      await this.refresh();
      this.dialog.close();
      focus();
    });
  }

  editPhase({ root, project, revision }: ResearchSnapshot, today: string, original: ResearchPhase | undefined, focus: () => void) {
    if (this.dialog.open) return;
    const id = original?.id ?? `phase-${crypto.randomUUID()}`;
    this.show(`<form>${heading(original ? t("编辑阶段") : t("新建阶段"))}
      <div class="research-form-grid">
        <label class="wide">${ht("阶段名称")}<input name="title" value="${escapeResearch(original?.title ?? '')}" required maxlength="240" autofocus></label>
        <label>${ht("开始日期")}<input name="start" type="date" value="${escapeResearch(original?.start ?? today)}" required></label>
        <label>${ht("结束日期（可选）")}<input name="end" type="date" value="${escapeResearch(original?.end ?? '')}"></label>
        <label class="wide">${ht("本阶段要判断什么")}<textarea name="description" rows="3" maxlength="2000">${escape(original?.description || '')}</textarea></label>
        ${project.phaseGoals !== 'hidden' ? `<label class="wide">${ht("阶段目标（每行一项）")}<textarea name="goals" rows="4">${escape(original?.goals?.map(goal => goal.text).join('\n') || '')}</textarea></label>` : ''}
      </div>
      ${feedback}<div class="research-actions">
        <button type="button" class="secondary-button" data-tools-close>${ht("取消")}</button>
        <button type="submit" class="primary-button">${ht("保存")}</button>
      </div></form>`);
    this.submit(async data => {
      const title = String(data.get('title')).trim();
      const start = String(data.get('start')), end = String(data.get('end'));
      if (end && end < start) throw new Error(t("结束日期不能早于开始日期。"));
      const description = String(data.get('description')).trim();
      const goalText = data.get('goals');
      const previous = original?.goals || [];
      const goals = goalText === null ? previous : String(goalText).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
        .map(text => previous.find(goal => goal.text === text) || { text });
      const phase: ResearchPhase = { id, title, start, ...(end ? { end } : {}),
        ...(description ? { description } : {}), ...(goals.length ? { goals } : {}) };
      const phases = original ? project.phases.map(item => item.id === id ? phase : item) : [...project.phases, phase];
      await window.meki.configureResearchProject(root, { ifRevision: revision, project: { ...project, phases } });
      await this.refresh();
      this.dialog.close();
      focus();
    });
  }

  registerSource(root: string) {
    this.show(`<form>${heading(t("登记只读来源"))}
      <div class="research-form-grid">
        <label>${ht("来源名称")}<input name="label" required maxlength="240" autofocus></label>
        <label>${ht("来源 ID")}<input name="id" required pattern="[a-z][a-z0-9_\\-]{0,63}" placeholder="source-id"></label>
      </div>${feedback}<div class="research-actions"><button type="submit" class="primary-button">${ht("选择目录并绑定")}</button></div>
    </form>`);
    this.submit(async data => {
      if (await window.meki.bindResearchSource(root, String(data.get('id')).trim(), String(data.get('label')).trim())) {
        this.dialog.close(); await this.refresh();
      }
    });
  }

  registerEvidence(root: string, sourceId: string) {
    this.show(`<form>${heading(t("登记原始证据"))}
      <div class="research-form-grid">
        <label>${ht("证据 ID")}<input name="id" required pattern="[a-z][a-z0-9_\\-]{0,63}" placeholder="evidence-id" autofocus></label>
        <label>${ht("证据名称")}<input name="label" maxlength="240" placeholder="${ht("默认使用文件名")}"></label>
      </div>${feedback}<div class="research-actions"><button type="submit" class="primary-button">${ht("选择文件并登记")}</button></div>
    </form>`);
    this.submit(async data => {
      if (await window.meki.indexResearchEvidence(root, sourceId, String(data.get('id')).trim(), String(data.get('label')).trim() || undefined)) {
        this.dialog.close(); await this.refresh();
      }
    });
  }

  async bind(root: string, sourceId: string) {
    if (await window.meki.bindResearchSource(root, sourceId)) await this.refresh();
  }

  closeEvidence(focus = true) {
    ++this.evidenceRequest;
    const returning = this.evidenceReturn;
    if (!returning) return false;
    this.evidenceReturn = undefined;
    this.evidenceTabs.clear();
    this.temporaryEvidenceId = undefined;
    this.displayedEvidence = undefined;
    this.inspector.removeAttribute('data-expanded');
    const { origin, scroll, before, opened } = returning;
    const restoreScroll = focus && Math.abs(scroll.scrollTop - opened) < 1;
    this.inspector.hidden = true;
    this.inspector.replaceChildren();
    if (restoreScroll) scroll.scrollTop = before;
    if (focus) {
      const target = origin?.closest('#research-reader-related[hidden]') ? document.getElementById('research-reference-toggle') : origin;
      (target?.isConnected ? target : document.getElementById('research-reader-title'))?.focus({ preventScroll: true });
    }
    return true;
  }

  private labelEvidenceSize() {
    const control = this.inspector.querySelector<HTMLButtonElement>('[data-evidence-expand]')!;
    const expanded = this.inspector.hasAttribute('data-expanded');
    control.title = expanded ? t("恢复并排阅读") : t("展开证据预览");
    control.setAttribute('aria-label', control.title);
    control.setAttribute('aria-pressed', String(expanded));
  }

  private makeTemporary(tab: EvidenceTab) {
    if (this.temporaryEvidenceId) this.evidenceTabs.delete(this.temporaryEvidenceId);
    this.evidenceTabs.delete(tab.id);
    this.evidenceTabs.set(tab.id, tab);
    this.temporaryEvidenceId = tab.id;
  }

  private selectEvidenceTab(tab: EvidenceTab, focusTab: boolean) {
    const previous = this.displayedEvidence;
    if (previous) previous.scroll = { left: previous.viewport.scrollLeft, top: previous.viewport.scrollTop };
    const tabs = [...this.evidenceTabs.values()].map(item => {
      const pinned = item.id !== this.temporaryEvidenceId;
      const state = pinned ? ht("已固定") : ht("临时预览");
      return `<span role="presentation"><button type="button" role="tab" id="research-evidence-tab-${escape(item.id)}" data-evidence-tab="${escape(item.id)}" aria-selected="${item === tab}" tabindex="${item === tab ? 0 : -1}" aria-controls="research-active-evidence" aria-description="${state}" title="${escape(item.title)} · ${state}">${pinned ? icon('pin', 12) : ''}${escape(item.title)}</button>
        <button type="button" data-dismiss-evidence="${escape(item.id)}" aria-label="${ht("关闭 {0}", escape(item.title))}">${icon('close', 12)}</button></span>`;
    });
    this.inspector.innerHTML = `<div class="research-evidence-tabs" role="tablist" aria-label="${ht("原始证据")}">${tabs.join('')}</div>` + tab.markup;
    this.inspector.querySelector('.research-evidence-content')!.replaceWith(tab.body);
    this.displayedEvidence = tab;
    if (tab.scroll) tab.viewport.scrollTo(tab.scroll);
    tab.body.id = 'research-active-evidence';
    tab.body.setAttribute('role', 'tabpanel');
    tab.body.setAttribute('aria-labelledby', 'research-evidence-tab-' + tab.id);
    const pin = this.inspector.querySelector<HTMLButtonElement>('[data-evidence-pin]')!;
    const pinned = tab.id !== this.temporaryEvidenceId;
    pin.setAttribute('aria-pressed', String(pinned));
    pin.title = pinned ? t("取消固定") : t("固定到右栏");
    pin.querySelector('span')!.textContent = pinned ? t("已固定") : t("固定到右栏");
    this.inspector.querySelector('[data-evidence-reveal]')!.addEventListener('click', tab.reveal);
    this.labelEvidenceSize();
    this.evidenceReturn!.origin = tab.origin;
    const selected = this.inspector.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    (focusTab && selected ? selected : this.inspector.querySelector<HTMLButtonElement>('[data-tools-close]'))?.focus({ preventScroll: true });
    if (focusTab) selected?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  async evidence(root: string, id: string, sourceDocument?: string, returnLabel = t("返回正文"), origin?: HTMLElement, besideReader = false, locator?: ResearchSearchLocator) {
    const request = ++this.evidenceRequest;
    const existing = besideReader && this.evidenceTabs.get(id);
    if (existing) { existing.origin = origin; this.selectEvidenceTab(existing, true); return; }
    const file = await window.meki.openResearchEvidence(root, id, sourceDocument);
    if (request !== this.evidenceRequest) return;
    if (file.kind === 'pdf' || file.kind === 'pptx') {
      this.report.show([file], {
        read: async () => file,
        reveal: () => window.meki.revealResearchEvidence(root, id, sourceDocument),
        notify: this.notify, origin, initialPage: locator?.kind === 'page' ? locator.page : undefined,
      });
      return;
    }
    const markup = `<div class="dialog-heading research-evidence-heading">
      <button type="button" class="icon-button" data-tools-close aria-label="${escape(returnLabel)}" title="${escape(returnLabel)}" autofocus>${icon('back', 17)}</button>
      <div><h2 id="${besideReader ? 'research-inspector-title' : 'research-tools-title'}">${escape(file.title)}</h2><small>${escape(file.source)} · ${escape(file.relativePath)}</small></div>
      ${besideReader ? `<button type="button" class="icon-button" data-evidence-expand>${icon('focus', 15)}</button>` : ''}${closeButton(ht("关闭证据预览"))}
    </div><div class="research-evidence-content"></div>
    <div class="research-actions research-evidence-footer"><span>${ht("只读来源")}</span>
      ${besideReader ? `<button type="button" class="secondary-button" data-evidence-pin="${escape(id)}" aria-label="${ht("固定到右栏")}">${icon('pin', 14)}<span></span></button>` : ''}
      <button type="button" class="secondary-button" data-evidence-reveal>${ht("定位原文件")}</button></div>`;
    const reveal = () => { void window.meki.revealResearchEvidence(root, id, sourceDocument).catch(error => this.notify(String(error), true)); };
    if (besideReader) {
      const scroll = document.getElementById('document-scroll')!;
      const before = this.evidenceReturn?.before ?? scroll.scrollTop;
      const opened = this.evidenceReturn?.opened;
      this.inspector.hidden = false;
      this.evidenceReturn = { origin, scroll, before, opened: opened ?? scroll.scrollTop };
      const body = evidenceContent(file);
      const tab = { id, title: file.title, body, markup, reveal, origin, viewport: body.querySelector<HTMLElement>('.research-table-scroll') ?? body };
      this.makeTemporary(tab);
      this.selectEvidenceTab(tab, false);
    } else {
      this.show(markup, 'research-evidence-preview');
      const body = evidenceContent(file);
      this.dialog.querySelector('.research-evidence-content')!.replaceWith(body);
      if (locator?.kind === 'paragraph' || locator?.kind === 'trial') revealEvidenceLine(body, locator);
      this.dialog.querySelector('[data-evidence-reveal]')!.addEventListener('click', reveal);
      if (origin) this.dialog.addEventListener('close', () => {
        if (!this.dialog.open && origin.isConnected) origin.focus({ preventScroll: true });
      }, { once: true });
    }
  }

  previewReports(root: string, files: ResearchReference[], origin: HTMLButtonElement | undefined, viewBody: () => Promise<void>) {
    this.report.show(files, {
      read: id => window.meki.openResearchEvidence(root, id),
      reveal: id => window.meki.revealResearchEvidence(root, id),
      origin, viewBody, notify: this.notify,
    });
  }

  async importPreview(root: string, sourceId: string) {
    this.show(`<div class="research-import-loading">${heading(t("导入实验归档"))}<p role="status">${ht("正在扫描归档…")}</p></div>`, 'research-import-preview');
    try {
      const plan = await window.meki.researchImportPreview(root, sourceId);
      if (this.dialog.open && this.dialog.querySelector('.research-import-loading')) this.renderImport(root, plan);
    } catch (error) {
      if (!this.dialog.querySelector('.research-import-loading')) return;
      this.dialog.close();
      this.notify(String(error), true);
    }
  }

  private renderImport(root: string, plan: ResearchImportPreview) {
    const labels = { new: t("新增"), changed: t("有变化"), unchanged: t("无变化"), blocked: t("待确认") };
    const counts = Object.entries(labels).map(([status, label]) => `${label} ${plan.runs.filter(run => run.change === status).length}`);
    const missing = plan.runs.filter(run => run.missing.length).length;
    const changed = plan.runs.filter(run => run.change === 'new' || run.change === 'changed').length;
    const rows = (runs: ResearchImportPreview['runs']) => `<ul class="research-import-runs">${runs.map(run => `<li>
      <strong>${escape(run.title)}</strong><span>${escape(labels[run.change])}${run.missing.includes('RUN.md') ? ` · ${ht("待补报告")}` : ''}</span>
      <small>${escape(run.runId)} · ${escape(run.directory)}${run.missing.length ? `<br>${ht("缺件 {0}", escape(run.missing.join(', ')))}` : ''}</small>
      ${run.error ? `<small>${escape(run.error)}</small>` : ''}</li>`).join('')}</ul>`;
    const needsReview = plan.runs.filter(run => run.change !== 'unchanged' || run.missing.length || run.error);
    const unchanged = plan.runs.filter(run => !needsReview.includes(run));
    this.show(`<form>${heading(t("导入实验归档"))}
      <div class="research-import-counts" role="status">${escape(counts.join(' · '))} · ${ht("{0} 个运行有缺件", missing)}</div>
      ${needsReview.length ? rows(needsReview) : ''}${unchanged.length ? `<details><summary>${ht("查看未变化的运行")}</summary>${rows(unchanged)}</details>` : ''}
      ${plan.runs.length ? '' : `<p>${ht("这个来源中没有找到实验运行目录。")}</p>`}
      ${feedback}<div class="research-actions"><button type="submit" class="primary-button"${changed ? '' : ' disabled'}>${ht("确认导入 {0} 条记录", changed)}</button></div>
    </form>`, 'research-import-preview');
    this.submit(async () => {
      const result = await window.meki.applyResearchImport(root, plan.sourceId, plan.token);
      this.dialog.close();
      await this.refresh();
      this.notify(t("已导入或更新 {0} 条实验记录", result.records.filter(record => record.changed).length));
    });
  }

  filter(state: ResearchSnapshot, current: ResearchFilter | undefined, apply: (filter?: ResearchFilter) => Promise<void>) {
    const fields = new Map(state.project.recordTypes.flatMap(type => type.fields.map(field => [field.id, field.label] as const)));
    Object.entries(runFields()).forEach(([id, label]) => fields.set(`run.${id}`, label));
    const presets = state.project.savedFilters || [];
    this.show(`<form>${heading(t("研究筛选"))}
      ${presets.length ? `<label class="research-filter-preset">${ht("已保存的筛选")}<select name="preset">${option('', t("选择筛选"), '')}${presets.map(filter => option(filter.id, filter.label, '')).join('')}</select></label>` : ''}
      <div class="research-form-grid">
        <label>${ht("关键词")}<input name="query" maxlength="500" placeholder="${ht("多个关键词用空格分隔")}" autofocus></label>
        <label>${ht("实验月份")}<input name="month" type="month"></label>
      </div><div data-filter-fields></div>
      <button type="button" class="secondary-button" data-add-filter-field>${icon('plus', 14)} ${ht("添加字段条件")}</button>
      ${feedback}<div class="research-filter-footer">
        <label>${ht("筛选名称")}<input name="label" maxlength="240" placeholder="${ht("用于保存常用筛选")}"></label>
        <div class="research-actions"><button type="submit" class="secondary-button" data-save-filter>${ht("保存并应用")}</button>
          <button type="submit" class="primary-button">${ht("应用")}</button></div>
      </div>
    </form>`, 'research-filter-dialog');
    const form = this.dialog.querySelector('form')!;
    const fieldRows = form.querySelector('[data-filter-fields]')!;
    const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const add = (field = '', value = '') => {
      if (fieldRows.childElementCount >= 12) return;
      const options = [...fields];
      if (field && !fields.has(field)) options.push([field, field]);
      fieldRows.insertAdjacentHTML('beforeend', `<div class="research-filter-field-row">
        <select name="field" aria-label="${ht("筛选字段")}">${option('', t("选择字段"), field)}${options.map(([id, label]) => option(id, label, field)).join('')}</select>
        <input name="value" aria-label="${ht("匹配值")}" value="${escape(value)}" maxlength="500">
        <button type="button" class="icon-button" data-remove-filter-field aria-label="${ht("移除此条件")}">${icon('close', 14)}</button></div>`);
    };
    const fill = (filter: ResearchFilter | undefined, label = '') => {
      input('query').value = filter?.query || '';
      input('month').value = filter?.month || '';
      input('label').value = label;
      fieldRows.replaceChildren();
      filter?.fields?.forEach(({ field, value }) => add(field, value));
    };
    fill(current);
    form.querySelector('[name=preset]')?.addEventListener('change', event => {
      const preset = presets.find(item => item.id === (event.target as HTMLSelectElement).value);
      fill(preset, preset?.label);
    });
    form.querySelector('[data-add-filter-field]')!.addEventListener('click', () => {
      add(); fieldRows.lastElementChild?.querySelector('select')?.focus();
    });
    fieldRows.addEventListener('click', event => (event.target as Element).closest('[data-remove-filter-field]')?.parentElement?.remove());
    this.submit(async (data, submitter) => {
      const query = String(data.get('query')).trim(), month = String(data.get('month'));
      const values = data.getAll('value').map(value => String(value).trim());
      const filters = data.getAll('field').flatMap((field, i) => {
        if (!field && !values[i]) return [];
        if (!field || !values[i]) throw new Error(t("请为每个字段条件填写字段和值。"));
        return [{ field: String(field), value: values[i] }];
      });
      const filter: ResearchFilter = { ...(query ? { query } : {}), ...(month ? { month } : {}), ...(filters.length ? { fields: filters } : {}) };
      const active = Object.keys(filter).length > 0;
      if (submitter?.hasAttribute('data-save-filter')) {
        const label = String(data.get('label')).trim();
        if (!active || !label) throw new Error(t("填写筛选名称和至少一个条件后再保存。"));
        await window.meki.saveResearchFilter(state.root, label, filter);
      }
      this.dialog.close();
      await apply(active ? filter : undefined);
    });
  }
}

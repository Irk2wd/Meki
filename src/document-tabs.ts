import { t, ht, getLocale } from '../electron/i18n.mjs';
import type { DocumentFile, DocumentSession, DocumentSnapshot, DocumentStatus, RestoredSession, SavePause, SessionDocument, Settings } from '../shared/moye';
import type { WritingEditor, EditorSnapshot } from './editor';
import { ClosedDocuments, type ClosedDocument } from '../electron/closed-documents.mjs';
import './document-tabs.css';
import type { PaneWorkspace, DockRequest } from './pane-workspace';
import { groups, reconcileLayout, type PaneLayout } from '../electron/pane-layout.mjs';

export interface DocumentTab {
  id: string; document: DocumentFile; savedContent: string; snapshot?: EditorSnapshot;
  mode: 'visual' | 'source'; scroll: number; recovered: boolean; paused: SavePause;
  status: DocumentStatus | null; acknowledged: string;
  editedAt: number; snapshotAt: number; snapshotContent: string | null;
}
interface Hooks {
  editor(): WritingEditor; settings(): Settings; platform(): string; panes(): PaneWorkspace;
  active(document: DocumentFile): void; updated(): void;
  dispatch(command: string, payload?: unknown): void; notify(message: string, error?: boolean): void;
}
const escaped = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pauseLabels = { external: t("外部文件已变化，自动保存已暂停"), history: t("历史内容已恢复，请手动保存"), recovered: t("恢复内容已保留，请手动保存"), attachments: t("图片引用已整理，请手动保存"), error: t("自动保存已暂停，请手动保存") };
const blank = (): DocumentFile => ({ path: null, name: t("未命名.md"), content: '', revision: null });

export class DocumentTabs {
  tabs: DocumentTab[] = [];
  activeId: string | null = null;
  recoveryError = '';
  private closed = new ClosedDocuments();
  private bar: HTMLElement;
  private history: HTMLDialogElement;
  private settingsPanel: HTMLElement;
  private windowPanel: HTMLElement;
  private historyRequest = 0;
  private historySelection: { path: string; id: string; tabId: string } | null = null;

  constructor(private hooks: Hooks) {
    this.bar = document.createElement('div'); this.bar.className = 'document-tabs'; this.bar.setAttribute('aria-label', t("打开的文稿"));
    this.bar.innerHTML = `<div class="document-tab-list" role="tablist" aria-label="${ht("文稿标签")}"></div><button type="button" data-action="new" class="tab-add" aria-label="${ht("新建文稿标签")}" title="${ht("新建文稿")}">＋</button><button type="button" data-action="reopen-closed" class="tab-windows" aria-label="${ht("重新打开刚关闭文稿")}" disabled>${ht("重开")}</button><button type="button" data-action="window-menu" class="tab-windows" aria-label="${ht("窗口操作")}" title="${ht("新建、移动文稿与并排窗口")}">${ht("窗口")}</button><button type="button" data-action="lifecycle-settings" class="tab-settings" aria-label="${ht("文稿与保存设置")}" title="${ht("文稿与保存")}">•••</button>`;
    document.querySelector('.titlebar')!.after(this.bar);
    this.windowPanel = document.createElement('div'); this.windowPanel.className = 'popover window-panel'; this.windowPanel.id = 'window-panel'; this.windowPanel.hidden = true;
    this.windowPanel.innerHTML = `<div class="popover-title">${ht("窗口")}</div><button type="button" data-action="new-window">${ht("新建窗口")} <span>Ctrl / ⌘ Shift N</span></button><button type="button" data-action="detach-document">${ht("将当前文稿移至新窗口")}</button><button type="button" data-action="tile-windows">${ht("左右并排")}</button>`;
    document.body.append(this.windowPanel);
    this.settingsPanel = document.createElement('div'); this.settingsPanel.className = 'popover lifecycle-settings'; this.settingsPanel.id = 'lifecycle-settings'; this.settingsPanel.hidden = true;
    this.settingsPanel.innerHTML = `<div class="popover-title">${ht("文稿与保存")}</div>
      <label class="setting-row">${ht("自动写回文件")}<input id="auto-save" type="checkbox" aria-label="${ht("自动保存文稿")}"></label>
      <label class="setting-row">${ht("停止输入后保存")}<select id="auto-save-interval" aria-label="${ht("自动保存间隔")}"><option value="2">${ht("2 秒")}</option><option value="5">${ht("5 秒")}</option><option value="10">${ht("10 秒")}</option><option value="30">${ht("30 秒")}</option><option value="60">${ht("1 分钟")}</option><option value="120">${ht("2 分钟")}</option><option value="600">${ht("10 分钟")}</option></select></label>
      <label class="setting-row">${ht("离开窗口时自动保存")}<input id="auto-save-blur" type="checkbox" aria-label="${ht("离开窗口时自动保存")}"></label>
      <p class="setting-note">${ht("自动保存开启后写回已有文件。未命名文稿需先保存；外部修改、草稿和快照恢复会暂停写回，检查后请手动保存。")}</p>
      <label class="setting-row">${ht("定期保留本地快照")}<input id="auto-snapshot" type="checkbox" aria-label="${ht("自动创建快照")}"></label>
      <label class="setting-row">${ht("快照间隔")}<select id="snapshot-interval" aria-label="${ht("自动快照间隔")}"><option value="10">${ht("10 秒")}</option><option value="30">${ht("30 秒")}</option><option value="60">${ht("1 分钟")}</option><option value="300">${ht("5 分钟")}</option><option value="600">${ht("10 分钟")}</option></select></label>
      <p class="setting-note">${ht("只在内容变化后创建，包括未命名文稿；保存在本机，不改动原文件。手动快照不会自动清理。")}</p>
      <button class="theme-edit-button" data-action="snapshots">${ht("查看与创建快照 →")}</button>
      <label class="setting-row">${ht("打开上次会话")}<input id="reopen-session" type="checkbox" aria-label="${ht("打开上次会话")}"></label>
      <button class="theme-edit-button" data-action="history">${ht("写入前的版本历史 →")}</button><button class="theme-edit-button" data-action="reopen-closed" disabled>${ht("重新打开刚关闭文稿")}</button><p class="setting-note">${ht("本窗口保留最近 20 份／32 MiB 关闭内容，退出后清除。恢复未保存内容会暂停自动保存。")}</p><button class="theme-edit-button" data-action="shortcut-settings">${ht("自定义快捷键…")}</button><button class="theme-edit-button" data-action="close-all">${ht("关闭全部文稿")}</button>`;
    document.body.append(this.settingsPanel);
    this.history = document.createElement('dialog'); this.history.id = 'history-dialog';
    this.history.innerHTML = `<form method="dialog"><div class="dialog-heading"><div><span class="eyebrow">LOCAL VERSIONS</span><h2>${ht("文稿的本地版本")}</h2></div><button value="close" class="icon-button" aria-label="${ht("关闭版本历史")}">×</button></div><p class="history-help">${ht("保留每次写入前的文件内容。选择版本后恢复到编辑区，确认后再手动保存。")}</p><div class="history-layout"><div id="history-list" role="list" aria-label="${ht("历史版本列表")}"></div><textarea id="history-preview" readonly aria-label="${ht("历史版本内容")}" spellcheck="false"></textarea></div><p id="history-status" role="status"></p><div class="dialog-actions"><span>${ht("每文稿最多 20 版 / 32 MiB")}</span><button id="restore-version" type="button" class="primary-button" disabled>${ht("恢复到编辑区")}</button></div></form>`;
    document.body.append(this.history);
    document.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-document-id]');
      if (target) this.hooks.dispatch(target.dataset.closeTab ? 'close-tab' : 'activate-tab', target.dataset.documentId);
    });
    this.history.querySelector('#restore-version')!.addEventListener('click', () => { if (this.historySelection) this.hooks.dispatch('restore-version', this.historySelection); });
    document.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('.lifecycle-settings,[data-action="lifecycle-settings"]')) this.settingsPanel.hidden = true;
      if (!(event.target as HTMLElement).closest('[data-action="window-menu"]')) this.windowPanel.hidden = true;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !this.windowPanel.hidden) {
        this.windowPanel.hidden = true;
        this.bar.querySelector<HTMLButtonElement>('[data-action="window-menu"]')?.focus();
      }
    });
    for (const [selector, key, value] of [
      ['#auto-save', 'autoSave', 'checked'], ['#auto-save-interval', 'autoSaveInterval', 'value'], ['#reopen-session', 'reopenSession', 'checked'],
      ['#auto-save-blur', 'autoSaveOnBlur', 'checked'], ['#auto-snapshot', 'autoSnapshot', 'checked'], ['#snapshot-interval', 'snapshotInterval', 'value'],
    ] as const) this.settingsPanel.querySelector(selector)!.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      this.hooks.dispatch('lifecycle-setting', { [key]: value === 'checked' ? input.checked : Number(input.value) });
    });
  }

  get active() { return this.tabs.find(tab => tab.id === this.activeId)!; }
  dirty(tab = this.active) { return tab ? tab.document.content !== tab.savedContent : false; }
  private pathKey(path: string) { return this.hooks.platform() === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path; }
  findPath(path: string) { return this.tabs.find(tab => tab.document.path && this.pathKey(tab.document.path) === this.pathKey(path)); }
  private create(doc: DocumentFile, saved?: SessionDocument, replacingAll = false): DocumentTab {
    if (!replacingAll && this.tabs.length >= 24) throw new Error(t("最多打开 24 个文稿，请先关闭部分标签。"));
    if (!replacingAll && new TextEncoder().encode(doc.content).length + this.tabs.reduce((sum, tab) => sum + new TextEncoder().encode(tab.document.content).length, 0) > 48 * 1024 * 1024) throw new Error(t("会话内容超过 48 MiB，请先关闭部分标签。"));
    let name = doc.name;
    if (!saved && !doc.path && name === t("未命名.md")) {
      let number = 1;
      while (!replacingAll && this.tabs.some(tab => tab.document.name === name)) name = t("未命名 {0}.md", ++number);
    }
    return { id: saved?.id || crypto.randomUUID(), document: { ...doc, name }, savedContent: saved?.dirty ? '\0' : doc.content,
      mode: saved?.mode || 'visual', recovered: saved?.dirty || false, paused: saved?.paused || null, scroll: 0, status: null, acknowledged: '',
      editedAt: Date.now(), snapshotAt: Date.now(), snapshotContent: saved?.dirty ? null : doc.content };
  }
  private capture() {
    if (!this.active) return;
    this.active.snapshot = this.hooks.editor().snapshot(); this.active.mode = this.hooks.editor().mode;
    this.active.scroll = document.querySelector('#document-scroll')!.scrollTop;
  }
  private show(tab: DocumentTab, reload = false) {
    this.activeId = tab.id; const loaded = this.hooks.panes().select(tab); this.hooks.active(tab.document);
    const editor = this.hooks.editor();
    if (!loaded || reload) {
      if (tab.snapshot && !reload) editor.restore(tab.snapshot);
      else { editor.load(tab.document.content); editor.setMode(tab.mode, tab.document.content); }
    }
    // Reapply current global writing preferences after restoring an older editor state.
    editor.updateSettings(this.hooks.settings());
    if (!loaded || reload) this.hooks.panes().views.get(tab.id)!.scroll.scrollTop = tab.scroll;
    document.querySelectorAll<HTMLElement>('[data-mode]').forEach(button => { const active = button.dataset.mode === editor.mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    this.render(); this.hooks.updated();
  }
  activate(id: string) {
    const next = this.tabs.find(tab => tab.id === id); if (!next || next === this.active) return;
    this.capture(); this.show(next);
  }
  async open(doc: DocumentFile, recovered = false) {
    const existing = doc.path ? this.findPath(doc.path) : undefined;
    if (existing) { this.activate(existing.id); return; }
    this.capture();
    const tab = this.create(doc); tab.recovered = recovered;
    if (recovered) { tab.savedContent = '\0'; tab.paused = 'recovered'; }
    await this.hooks.panes().prepare(tab); this.tabs.push(tab); this.show(tab); await this.persist();
  }
  async restore(session: RestoredSession, transferred = false) {
    this.hooks.panes().setLayout(session.layout);
    for (const saved of session.documents) {
      const tab = this.create(saved, saved); if (transferred) tab.recovered = false;
      await this.hooks.panes().prepare(tab); this.hooks.panes().restoreView(tab); this.tabs.push(tab);
    }
    if (this.tabs.length) { this.show(this.tabs.find(tab => tab.id === session.activeId) || this.tabs[0]); await this.persist(); }
  }
  async reload(doc: DocumentFile) {
    const tab = this.active;
    tab.document = { ...doc }; tab.savedContent = doc.content; tab.snapshot = undefined; tab.recovered = false; tab.paused = null; tab.status = null; tab.acknowledged = '';
    this.show(tab, true); await this.persist();
  }
  snapshot(): DocumentSession {
    if (this.active) this.active.mode = this.hooks.editor().mode;
    return { activeId: this.activeId, documents: this.tabs.map(tab => ({ ...tab.document, id: tab.id, dirty: this.dirty(tab), mode: this.hooks.panes().views.get(tab.id)?.editor.mode || tab.mode, paused: tab.paused })), layout: reconcileLayout(this.hooks.panes().snapshot(), this.tabs.map(tab => tab.id), this.activeId) };
  }
  async persist() {
    this.hooks.panes().flush(); const session = this.snapshot();
    await window.moye.saveSession(session);
    // An older write may finish while a close is awaiting its own commit.
    // Keep the views owned by either that committed snapshot or the current UI.
    await this.hooks.panes().prune(new Set([...session.documents.map(doc => doc.id), ...this.tabs.map(tab => tab.id)]));
  }
  toggleWindows() { this.windowPanel.hidden = !this.windowPanel.hidden; }
  async detach(tabId?: string) {
    if (tabId) this.activate(tabId);
    this.hooks.editor().flush(); await this.persist();
    const tab = this.active;
    if (!await window.moye.detachDocument(tab.id)) return;
    const index = this.tabs.indexOf(tab); this.tabs.splice(index, 1); this.activeId = null;
    if (!this.tabs.length) { const tab = this.create(blank()); await this.hooks.panes().prepare(tab); this.tabs.push(tab); }
    this.show(this.tabs[Math.min(index, this.tabs.length - 1)]); await this.persist();
    this.hooks.notify(t("文稿已移到新窗口。"));
  }
  async dock(request: DockRequest) {
    this.hooks.panes().flush(); this.capture(); const previous = this.hooks.panes().snapshot(), active = this.activeId;
    try { this.hooks.panes().dock(request); this.show(this.tabs.find(tab => tab.id === request.tabId)!); await this.persist(); }
    catch (error) { this.hooks.panes().setLayout(previous); if (active) this.show(this.tabs.find(tab => tab.id === active)!); throw error; }
  }
  async layout(input: { layout: PaneLayout; previous?: PaneLayout }) {
    this.hooks.panes().setLayout(input.layout); this.render();
    try { await this.persist(); }
    catch (error) { this.hooks.panes().setLayout(input.previous); this.render(); throw error; }
  }
  render() {
    this.hooks.panes().update(this.tabs, this.activeId);
    document.querySelectorAll<HTMLButtonElement>('[data-action="reopen-closed"]').forEach(button => { button.disabled = this.closed.length === 0; });
    const list = this.bar.querySelector<HTMLElement>('.document-tab-list')!;
    const ordered = groups(this.hooks.panes().snapshot()).flatMap(group => group.tabs).map(id => this.tabs.find(tab => tab.id === id)!);
    const html = `${ordered.map(tab => `<div class="document-tab ${tab === this.active ? 'active' : ''}"><button type="button" role="tab" aria-selected="${tab === this.active}" data-document-id="${tab.id}" title="${escaped(tab.document.path || tab.document.name)}"><span class="tab-dirty ${this.dirty(tab) ? 'visible' : ''}" aria-label="${this.dirty(tab) ? t("未保存") : t("已保存")}">●</span><span>${escaped(tab.document.name)}</span>${tab.paused ? `<span class="tab-paused" title="${ht("自动保存已暂停")}">Ⅱ</span>` : ''}</button><button type="button" data-document-id="${tab.id}" data-close-tab="true" class="close-document-tab" aria-label="${ht("关闭 {0}", escaped(tab.document.name))}">×</button></div>`).join('')}`;
    if (list.innerHTML !== html) list.innerHTML = html;
    document.querySelector<HTMLElement>('#recovery-banner')!.hidden = !this.active?.recovered;
    const status = this.active?.paused ? pauseLabels[this.active.paused] : '';
    this.bar.title = status;
    if (this.active) this.bar.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  pauseMessage() { return this.active?.paused ? pauseLabels[this.active.paused] : ''; }
  touched() { if (this.active) this.active.editedAt = Date.now(); }
  private canAutosave(tab: DocumentTab, force: boolean) {
    return this.hooks.settings().autoSave && tab.document.path && tab.document.revision && this.dirty(tab) && !tab.paused &&
      (force || Date.now() - tab.editedAt >= this.hooks.settings().autoSaveInterval * 1000);
  }
  autosaveDue(force = false) { return this.tabs.some(tab => this.canAutosave(tab, force)); }
  private snapshotDue(tab: DocumentTab) {
    return this.hooks.settings().autoSnapshot && tab.document.content !== tab.snapshotContent && Date.now() - tab.snapshotAt >= this.hooks.settings().snapshotInterval * 1000;
  }
  snapshotsDue() { return this.tabs.some(tab => this.snapshotDue(tab)); }
  toggleSettings() {
    this.settingsPanel.hidden = !this.settingsPanel.hidden;
    this.refreshSettings();
  }
  refreshSettings() {
    const settings = this.hooks.settings();
    this.settingsPanel.querySelector<HTMLInputElement>('#auto-save')!.checked = settings.autoSave;
    this.settingsPanel.querySelector<HTMLInputElement>('#reopen-session')!.checked = settings.reopenSession;
    this.settingsPanel.querySelector<HTMLInputElement>('#auto-save-blur')!.checked = settings.autoSaveOnBlur;
    this.settingsPanel.querySelector<HTMLInputElement>('#auto-snapshot')!.checked = settings.autoSnapshot;
    const snapshotInterval = this.settingsPanel.querySelector<HTMLSelectElement>('#snapshot-interval')!;
    if (![...snapshotInterval.options].some(option => Number(option.value) === settings.snapshotInterval)) snapshotInterval.add(new Option(t("{0} 秒", settings.snapshotInterval), String(settings.snapshotInterval)));
    snapshotInterval.value = String(settings.snapshotInterval);
    const interval = this.settingsPanel.querySelector<HTMLSelectElement>('#auto-save-interval')!;
    if (![...interval.options].some(option => Number(option.value) === settings.autoSaveInterval)) interval.add(new Option(t("{0} 秒", settings.autoSaveInterval), String(settings.autoSaveInterval)));
    interval.value = String(settings.autoSaveInterval);
  }

  async save(tab = this.active, saveAs = false, automatic = false) {
    this.hooks.editor().flush();
    this.recoveryError = '';
    try { await this.persist(); }
    catch (error) {
      if (automatic) throw error;
      this.recoveryError = t("会话恢复快照未能保存，继续保存当前文稿：{0}", String(error));
      this.hooks.notify(this.recoveryError, true);
    }
    const snapshot = { ...tab.document };
    let result: DocumentFile | null;
    if (automatic) {
      const outcome = await window.moye.autoSaveDocument({ ...snapshot, tabId: tab.id });
      if (outcome.status === 'paused') { tab.paused = 'external'; this.render(); this.hooks.notify(`${tab.document.name}：${outcome.reason}`, true); await this.persist(); return false; }
      result = outcome.document;
    } else result = await window.moye.saveDocument({ ...snapshot, saveAs, tabId: tab.id, otherPaths: this.tabs.filter(other => other !== tab && other.document.path).map(other => other.document.path!) });
    if (!result) return false;
    // Only the bytes submitted to this save become the baseline. Later keystrokes stay dirty.
    this.hooks.editor().flush();
    tab.document.path = result.path; tab.document.name = result.name; tab.document.revision = result.revision; tab.savedContent = result.content;
    tab.paused = null; tab.status = null; tab.acknowledged = ''; tab.recovered = false;
    try { await this.persist(); }
    catch (error) { this.recoveryError = t("文稿已保存，但会话恢复快照失败：{0}", String(error)); this.hooks.notify(this.recoveryError, true); }
    this.render(); this.hooks.updated(); return true;
  }
  async autosave(force = false) {
    this.hooks.editor().flush();
    for (const tab of this.tabs) {
      if (!this.canAutosave(tab, force)) continue;
      try { await this.save(tab, false, true); }
      catch (error) { tab.paused = 'error'; this.hooks.notify(t("{0}：自动保存已暂停，{1}", tab.document.name, String(error)), true); await this.persist(); }
    }
    this.render(); this.hooks.updated();
  }
  async createSnapshot(kind: DocumentSnapshot['kind'], label = '', tab = this.active) {
    this.hooks.editor().flush();
    const input = { ...tab.document, tabId: tab.id, kind, label };
    await this.persist();
    const result = await window.moye.createSnapshot(input);
    tab.snapshotContent = input.content; tab.snapshotAt = Date.now();
    return result;
  }
  async autoSnapshots() {
    this.hooks.editor().flush();
    for (const tab of this.tabs) {
      if (!this.snapshotDue(tab)) continue;
      // Retry only after another interval; disk/quota errors must not loop each second.
      tab.snapshotAt = Date.now();
      try { await this.createSnapshot('auto', '', tab); }
      catch (error) {
        const message = String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '');
        this.hooks.notify(t("{0}：自动快照失败，{1}", tab.document.name, message), true);
      }
    }
  }
  async restoreBuffer(content: string) {
    this.active.document.content = content;
    if (!this.dirty()) this.active.savedContent = '\0';
    this.active.paused = 'history'; this.active.snapshot = undefined; this.active.recovered = false;
    this.touched(); this.show(this.active, true); await this.persist();
  }
  async mayClose(tab = this.active) {
    this.hooks.editor().flush(); if (!this.dirty(tab)) return 'discard';
    const answer = await window.moye.confirmDiscard(tab.document.name);
    if (answer === 'save') return (await this.save(tab)) && !this.dirty(tab) ? 'save' : 'cancel';
    return answer;
  }
  async close(id = this.activeId) {
    const tab = this.tabs.find(tab => tab.id === id); if (!tab) return;
    this.activate(tab.id);
    if (await this.mayClose(tab) === 'cancel') return;
    this.capture(); const record = this.closedRecord(tab), previous = [...this.tabs], active = this.activeId, layout = this.hooks.panes().snapshot();
    const siblings = groups(layout).find(group => group.tabs.includes(id!))!.tabs;
    const remaining = siblings.filter(other => other !== id), neighbor = remaining[Math.min(siblings.indexOf(id!), remaining.length - 1)];
    const index = this.tabs.indexOf(tab); this.tabs.splice(index, 1); this.activeId = null;
    if (!this.tabs.length) { const tab = this.create(blank()); await this.hooks.panes().prepare(tab); this.tabs.push(tab); }
    this.show(this.tabs.find(tab => tab.id === neighbor) || this.tabs[Math.min(index, this.tabs.length - 1)]);
    try { await this.persist(); }
    catch (error) { this.tabs = previous; this.hooks.panes().setLayout(layout); this.show(this.tabs.find(item => item.id === active)!); throw error; }
    this.closed.push([record]); this.render();
  }
  async closeAll(windowClose = false) {
    this.hooks.editor().flush();
    const discarded = new Set<string>();
    for (const tab of this.tabs) {
      if (!this.dirty(tab)) continue;
      this.activate(tab.id);
      const answer = await this.mayClose(tab); if (answer === 'cancel') return false;
      if (answer === 'discard') discarded.add(tab.id);
    }
    if (windowClose) {
      const session = this.snapshot(); session.documents = session.documents.filter(doc => !discarded.has(doc.id));
      if (!session.documents.some(doc => doc.id === session.activeId)) session.activeId = session.documents[0]?.id || null;
      session.layout = reconcileLayout(session.layout, session.documents.map(doc => doc.id), session.activeId);
      await window.moye.saveSession(session, true);
    } else {
      this.capture(); const previous = [...this.tabs], active = this.activeId, layout = this.hooks.panes().snapshot();
      const records = [...this.tabs.filter(tab => tab !== this.active), this.active].map(tab => this.closedRecord(tab));
      const blankTab = this.create(blank(), undefined, true); await this.hooks.panes().prepare(blankTab); this.tabs = [blankTab]; this.activeId = null; this.show(blankTab);
      try { await this.persist(); }
      catch (error) { this.tabs = previous; this.hooks.panes().setLayout(layout); this.show(this.tabs.find(tab => tab.id === active)!); throw error; }
      this.closed.push(records); this.render();
    }
    return true;
  }
  private closedRecord(tab: DocumentTab): ClosedDocument {
    return { document: { ...tab.document }, savedContent: tab.savedContent, dirty: this.dirty(tab), mode: tab.mode, scroll: tab.scroll, sourceScroll: tab.snapshot?.sourceScroll || 0 };
  }
  async reopenClosed() {
    const record = this.closed.peek(); if (!record) { this.hooks.notify(t("本窗口没有可重新打开的文稿。")); return; }
    this.hooks.editor().flush(); this.capture();
    const local = record.document.path ? this.findPath(record.document.path) : undefined;
    if (local && !record.dirty) { this.activate(local.id); await this.persist(); this.closed.pop(); this.render(); return; }
    const result = record.document.path && !local ? await window.moye.reopenClosedDocument({ path: record.document.path, revision: record.document.revision, dirty: record.dirty }) : { kind: 'copy' as const };
    if (result.kind === 'existing') { this.closed.pop(); this.render(); if (result.message) this.hooks.notify(result.message); return; }
    const recovered = record.dirty || result.kind === 'copy';
    const doc = result.kind === 'disk' ? result.document! : result.kind === 'buffer' ? { ...record.document, path: result.document!.path, revision: result.document!.revision } : { ...record.document, path: null, revision: null, name: record.document.path ? t("{0}（恢复副本）.md", record.document.name.replace(/\.(md|markdown|txt)$/i, '')) : record.document.name };
    const previous = [...this.tabs], active = this.activeId;
    let tab: DocumentTab;
    try {
      tab = this.create(doc); tab.mode = record.mode; tab.scroll = record.scroll;
      if (recovered) { tab.savedContent = result.kind === 'buffer' ? record.savedContent : '\0'; tab.paused = 'recovered'; tab.recovered = true; }
      await this.hooks.panes().prepare(tab); this.tabs.push(tab); this.show(tab);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      document.querySelector('#document-scroll')!.scrollTop = record.scroll;
      this.hooks.editor().source.scrollDOM.scrollTop = record.sourceScroll;
      await this.persist();
    } catch (error) {
      this.tabs = previous; if (active) this.show(this.tabs.find(item => item.id === active)!);
      if (doc.path && !local) await window.moye.releaseDocument(doc.path).catch(() => {});
      throw error;
    }
    this.closed.pop(); this.render();
    this.hooks.notify(result.message || (recovered ? t("已找回关闭前的未保存内容，自动保存已暂停。请检查后手动保存。") : t("已重新读取并打开磁盘上的文稿。")));
  }
  remap(map: (path: string) => string | null | undefined) {
    this.hooks.editor().flush();
    for (const tab of this.tabs) {
      const next = tab.document.path ? map(tab.document.path) : undefined;
      if (next === undefined) continue;
      tab.document.path = next;
      if (next) tab.document.name = next.split(/[\\/]/).pop()!;
      else { tab.document.revision = null; tab.savedContent = '\0'; tab.paused = 'external'; }
      tab.status = null; tab.acknowledged = '';
    }
    this.render(); this.hooks.updated();
  }
  async showHistory() {
    const tab = this.active; const path = tab.document.path;
    if (!path) { this.hooks.notify(t("先保存文稿，再查看它的本地版本历史。")); return; }
    this.settingsPanel.hidden = true;
    const request = ++this.historyRequest;
    const versions = await window.moye.listVersions(path);
    if (request !== this.historyRequest || tab !== this.active) return;
    this.historySelection = null;
    this.history.querySelector<HTMLButtonElement>('#restore-version')!.disabled = true;
    this.history.querySelector<HTMLTextAreaElement>('#history-preview')!.value = '';
    this.history.querySelector('#history-status')!.textContent = versions.length ? t("选择一个版本预览。磁盘文件不会改变。") : t("尚无历史。修改并保存已有文件后，会保留写入前的版本。");
    const list = this.history.querySelector('#history-list')!;
    list.replaceChildren();
    for (const version of versions) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.versionId = version.id;
      button.textContent = `${new Date(version.createdAt).toLocaleString(getLocale())} · ${Math.max(1, Math.ceil(version.size / 1024))} KiB`;
      button.addEventListener('click', () => {
        const selection = { path, id: version.id, tabId: tab.id }; this.historySelection = selection;
        this.history.querySelector<HTMLButtonElement>('#restore-version')!.disabled = true;
        void window.moye.readVersion(path, version.id).then(value => {
          if (this.historySelection !== selection) return;
          this.history.querySelector<HTMLTextAreaElement>('#history-preview')!.value = value.content;
          this.history.querySelector<HTMLButtonElement>('#restore-version')!.disabled = false;
          this.history.querySelector('#history-status')!.textContent = t("恢复后自动保存会暂停，确认内容后请手动保存。");
          list.querySelectorAll('button').forEach(node => node.classList.toggle('active', node === button));
        }).catch(error => this.hooks.notify(String(error), true));
      });
      list.append(button);
    }
    this.history.showModal();
  }
  async restoreVersion(selection: { path: string; id: string; tabId: string }) {
    if (selection.tabId !== this.activeId || selection.path !== this.active.document.path) throw new Error(t("文稿已切换，请重新选择历史版本。"));
    const version = await window.moye.readVersion(selection.path, selection.id);
    this.hooks.editor().flush();
    if (this.dirty() && await this.mayClose() === 'cancel') return;
    await this.createSnapshot('restore', t("恢复历史前"));
    await this.restoreBuffer(version.content);
    this.history.close(); this.hooks.notify(t("已恢复到编辑区，并保留恢复前快照。自动保存已暂停，请检查后手动保存。"));
  }
}

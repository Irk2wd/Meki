import { ht, t } from '../electron/i18n.mjs';
import { bindings, commandFor, defaultBinding, eventBinding, shortcutCatalog, shortcutIds, shortcutLabel, validateBindings } from '../electron/shortcuts.mjs';
import type { Settings, ShortcutChange } from '../shared/moye';
import './shortcuts.css';
interface Host { settings(): Settings; platform(): string; blocked(): boolean; dispatch(command: string): void; save(change: ShortcutChange): Promise<void>; }
export class Shortcuts {
  private dialog = document.createElement('dialog');
  private recording: string | null = null;
  private working = false;
  private composing = false;
  constructor(private host: Host) {
    this.dialog.id = 'shortcuts-dialog';
    this.dialog.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2>${ht("自定义快捷键")}</h2><button value="close" class="icon-button" aria-label="${ht("关闭快捷键设置")}">×</button></div><p>${ht("点击“录制”后按组合键，Esc 取消。Ctrl / ⌘ 随平台切换；系统和文字编辑常用键保留。")}</p><div id="shortcut-rows"></div><p id="shortcut-feedback" role="status"></p><div class="dialog-actions"><span>${ht("保存后立即同步到其他窗口。")}</span><button type="button" id="shortcut-reset-all">${ht("全部恢复默认")}</button></div></form>`;
    document.body.append(this.dialog);
    this.dialog.addEventListener('close', () => { this.recording = null; this.render(); });
    this.dialog.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-shortcut-action]'); if (!button || this.working) return;
      const { shortcutAction: action, shortcutId: command } = button.dataset;
      if (action === 'record') { this.recording = command!; this.feedback(t("请按新的快捷键；Esc 取消。")); this.render(); }
      else if (action === 'clear' || action === 'reset') void this.save({ command: command!, value: action === 'clear' ? null : 'default' });
    });
    this.dialog.querySelector('#shortcut-reset-all')!.addEventListener('click', () => { void this.save({ resetAll: true }); });
    document.addEventListener('compositionstart', () => { this.composing = true; }, true);
    document.addEventListener('compositionend', () => { this.composing = false; }, true);
    document.addEventListener('keydown', event => this.keydown(event), true);
    // Native accelerators must also remain inactive while recording or editing a modal dialog.
    let guarded = false;
    void window.moye.shortcutCapture(false).catch(() => {});
    new MutationObserver(() => {
      const next = !!document.querySelector('dialog[open]');
      if (next !== guarded) { guarded = next; void window.moye.shortcutCapture(next).catch(() => {}); }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    this.apply();
  }
  private feedback(message: string) { this.dialog.querySelector('#shortcut-feedback')!.textContent = message; }
  private async save(change: ShortcutChange) {
    if (this.working) return; this.working = true; this.render();
    try { await this.host.save(change); this.recording = null; this.feedback(t("快捷键已保存。")); }
    catch (error) { this.feedback(String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '')); }
    finally { this.working = false; this.apply(); }
  }
  private keydown(event: KeyboardEvent) {
    if (this.composing || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return;
    if (this.dialog.open && this.recording) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { this.recording = null; this.feedback(t("已取消录制。")); this.render(); return; }
      if (event.repeat || this.working) return;
      const value = eventBinding(event, this.host.platform()); if (!value) return;
      try { validateBindings({ ...this.host.settings().shortcuts, [this.recording]: value }, this.host.platform()); void this.save({ command: this.recording, value }); }
      catch (error) { this.feedback(String(error).replace(/^Error: /, '')); }
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    const command = commandFor(event, this.host.settings().shortcuts, this.host.platform()), key = eventBinding(event, this.host.platform());
    // Consume app keys even while busy; retired defaults must never reach the editor's own commands.
    const retired = key && shortcutCatalog.some(item => defaultBinding(item.id, this.host.platform()) === key);
    if (!command && !retired) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (command && !event.repeat && !this.host.blocked()) this.host.dispatch(command);
  }
  allowsNative(command: string) { return !shortcutIds.has(command) || !this.composing && !document.querySelector('dialog[open]'); }
  async open() { await window.moye.shortcutCapture(true); this.recording = null; this.feedback(''); this.render(); this.dialog.showModal(); }
  private render() {
    const current = bindings(this.host.settings().shortcuts, this.host.platform()), rows = this.dialog.querySelector('#shortcut-rows')!;
    rows.replaceChildren(...shortcutCatalog.map(item => {
      const row = document.createElement('div'); row.className = 'shortcut-row';
      const label = document.createElement('span'); label.textContent = item.label; const key = document.createElement('kbd'); key.dataset.shortcutValue = item.id;
      key.textContent = this.recording === item.id ? t("请按组合键…") : shortcutLabel(current[item.id], this.host.platform()); row.append(label, key);
      for (const [action, text] of [['record', t("录制")], ['clear', t("清除")], ['reset', t("恢复默认")]]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.shortcutId = item.id; button.dataset.shortcutAction = action; button.textContent = text; button.disabled = this.working; row.append(button);
      }
      return row;
    }));
    this.dialog.querySelector<HTMLButtonElement>('#shortcut-reset-all')!.disabled = this.working;
  }
  apply() {
    this.render(); const current = bindings(this.host.settings().shortcuts, this.host.platform());
    const label = (id: string) => shortcutLabel(current[id], this.host.platform());
    document.querySelector('#open-shortcut')!.textContent = current.open ? label('open') : '';
    for (const item of shortcutCatalog) {
      document.querySelectorAll<HTMLElement>(`[data-action="${item.id}"],[data-edit-command="${item.id.replace(/^edit-/, '')}"]`).forEach(node => { node.title = `${item.label}${current[item.id] ? ` · ${label(item.id)}` : ''}`; });
    }
    const help = document.querySelector('.shortcut-list');
    if (help) help.replaceChildren(...shortcutCatalog.filter(item => current[item.id]).flatMap(item => {
      const name = document.createElement('span'); name.textContent = item.label; const key = document.createElement('kbd'); key.textContent = label(item.id); return [name, key];
    }));
    const windowLabel = document.querySelector('#window-panel [data-action="new-window"] span'); if (windowLabel) windowLabel.textContent = current['new-window'] ? label('new-window') : '';
  }
}

import { t, ht } from '../electron/i18n.mjs';
import type { WritingEditor } from './editor';
import type { InsertionPoint } from './editor-actions';
import type { Settings } from '../shared/moye';
import { CodeOptionsDialog } from './code-options-dialog';
import { clipboardCommands, type ClipboardCommand } from './editor-clipboard';
import './code-options.css';
interface MenuHost { blocked(): boolean; notify(message: string, error?: boolean): void; settings(): Settings; changeSettings(patch: Partial<Settings>): void }
const groups: Array<[string, Array<[string, string]>]> = [
  [t("编辑"), [['undo', t("撤销")], ['redo', t("重做")]]],
  [t("剪贴板"), [['copy-text', t("复制为纯文本")], ['copy-markdown', t("复制为 Markdown")], ['paste-text', t("粘贴纯文本")], ['paste-markdown', t("粘贴 Markdown")]]],
  [t("插入"), [['task', t("任务列表")], ['ordered', t("有序列表")], ['table', t("表格…")], ['link', t("链接…")], ['footnote', t("脚注…")], ['toc', t("目录")], ['alert', t("提示块")], ['quote', t("引用")]]],
  [t("文字"), [['highlight', t("高亮")], ['strike', t("删除线")], ['sub', t("下标")], ['sup', t("上标")]]],
  [t("表格"), [['table-row', t("增加一行")], ['table-col', t("增加一列")], ['table-delete-row', t("删除当前行")], ['table-delete-col', t("删除当前列")], ['table-align-left', t("列左对齐")], ['table-align-center', t("列居中")], ['table-align-right', t("列右对齐")]]],
];
export class FormatMenu {
  private get editor() { return this.getEditor(); }
  private menu: HTMLElement;
  private button: HTMLButtonElement;
  private dialog: HTMLDialogElement;
  private codeOptions: CodeOptionsDialog;
  private point?: InsertionPoint;
  private kind: 'link' | 'table' | 'footnote' = 'link';
  constructor(private getEditor: () => WritingEditor, private host: MenuHost) {
    this.codeOptions = new CodeOptionsDialog(() => host.settings(), patch => host.changeSettings(patch), () => this.editor.focus());

    const headings = document.querySelector('#heading-format')!;
    headings.insertAdjacentHTML('beforeend', `<option value="h4">${ht("四级标题")}</option><option value="h5">${ht("五级标题")}</option><option value="h6">${ht("六级标题")}</option>`);
    this.button = document.createElement('button'); this.button.type = 'button'; this.button.className = 'more-tools'; this.button.id = 'format-menu-button';
    this.button.textContent = t("更多 ▾"); this.button.title = t("插入与格式"); this.button.setAttribute('aria-label', t("更多插入与格式")); this.button.setAttribute('aria-expanded', 'false');
    document.querySelector('.format-actions')!.append(this.button);
    this.menu = document.createElement('div'); this.menu.id = 'format-menu'; this.menu.className = 'format-menu popover'; this.menu.hidden = true;
    this.menu.innerHTML = groups.map(([title, items]) => `<div class="format-menu-group"><span>${title}</span><div>${items.map(([command, label]) => `<button type="button" data-edit-command="${command}">${label}</button>`).join('')}</div></div>`).join('') + `<button type="button" class="code-lines-option" data-edit-command="code-lines" aria-pressed="true">${ht("✓ 代码块行号")}</button><button type="button" class="code-lines-option" data-edit-command="heading-numbering" aria-pressed="false">${ht("显示标题编号")}</button>`;
    document.body.append(this.menu);
    this.menu.insertAdjacentHTML('beforeend', `<button type="button" class="code-lines-option" data-edit-command="code-settings">${ht("代码块设置…")}</button>`);
    this.dialog = document.createElement('dialog'); this.dialog.id = 'insert-dialog';
    this.dialog.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2 id="insert-title">${ht("插入")}</h2><button class="icon-button" value="cancel" formnovalidate aria-label="${ht("取消插入")}">×</button></div><div id="insert-fields"></div><p id="insert-feedback" role="status"></p><div class="dialog-actions"><button value="cancel" formnovalidate class="secondary-button">${ht("取消")}</button><button type="button" class="primary-button" id="insert-confirm">${ht("插入")}</button></div></form>`;
    document.body.append(this.dialog);
    this.button.addEventListener('click', () => this.toggle());
    this.menu.addEventListener('mousedown', event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); });
    this.menu.addEventListener('click', event => { const command = (event.target as HTMLElement).closest<HTMLElement>('[data-edit-command]')?.dataset.editCommand; if (command) this.execute(command); });
    this.dialog.querySelector('#insert-confirm')!.addEventListener('click', () => this.confirm());
    this.dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); this.confirm(); } });
    document.addEventListener('mousedown', event => { if (!this.menu.contains(event.target as Node) && event.target !== this.button) this.close(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.close();
    }, true);
  }
  connect(editor: WritingEditor) { editor.code.onLastLanguage = codeLastLanguage => { if (this.host.settings().codeLastLanguage !== codeLastLanguage) this.host.changeSettings({ codeLastLanguage }); }; }
  apply(settings: Settings) { document.body.classList.toggle('hide-code-lines', !settings.codeLineNumbers); const option = this.menu.querySelector<HTMLElement>('[data-edit-command="code-lines"]')!; option.setAttribute('aria-pressed', String(settings.codeLineNumbers)); option.textContent = t("{0}代码块行号", settings.codeLineNumbers ? '✓ ' : ''); const headings = this.menu.querySelector<HTMLElement>('[data-edit-command="heading-numbering"]')!; headings.setAttribute('aria-pressed', String(settings.headingNumbering)); headings.textContent = t("{0}显示标题编号", settings.headingNumbering ? '✓ ' : ''); }
  private close() { this.menu.hidden = true; this.button.setAttribute('aria-expanded', 'false'); }
  private toggle() {
    if (this.host.blocked()) return;
    const open = this.menu.hidden; this.close(); if (!open) return;
    this.menu.hidden = false; this.button.setAttribute('aria-expanded', 'true');
    const bounds = this.button.getBoundingClientRect(); this.menu.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - 360))}px`; this.menu.style.top = `${bounds.bottom + 6}px`;
    this.menu.querySelectorAll<HTMLButtonElement>('[data-edit-command^="table-"]').forEach(button => { button.disabled = !this.editor.actions.inTable(); });
  }
  execute(command: string) {
    if (this.host.blocked()) return; this.close();
    if (command === 'code-lines') { this.host.changeSettings({ codeLineNumbers: !this.host.settings().codeLineNumbers }); return; }
    if (command === 'heading-numbering') { this.host.changeSettings({ headingNumbering: !this.host.settings().headingNumbering }); return; }
    if (command === 'code-settings') { this.codeOptions.show(); return; }
    if (clipboardCommands.has(command)) {
      if (document.querySelector('dialog[open]')) return;
      void this.editor.clipboard.execute(command as ClipboardCommand).then(message => { if (message) this.host.notify(message); }).catch(error => this.host.notify(String(error).replace(/^Error: /, ''), true)); return;
    }
    if (command === 'link' || command === 'footnote' || command === 'table') { this.showDialog(command); return; }
    try { if (!this.editor.actions.command(command)) this.host.notify(t("请把光标放在适合的位置，或选中文字后重试。")); }
    catch (error) { this.host.notify(String(error), true); }
  }
  private showDialog(kind: 'link' | 'footnote' | 'table') {
    this.kind = kind; this.point = this.editor.actions.capture();
    this.dialog.querySelector('#insert-title')!.textContent = { link: t("插入链接"), footnote: t("插入脚注"), table: t("插入表格") }[kind];
    const fields = this.dialog.querySelector('#insert-fields')!;
    fields.innerHTML = kind === 'link' ? `<label>${ht("显示文字")}<input id="insert-text" autocomplete="off"></label><label>${ht("链接地址")}<input id="insert-href" required placeholder="${ht("https:// 或 #章节")}" autocomplete="off"></label>` : kind === 'footnote' ? `<label>${ht("脚注内容")}<textarea id="insert-text" rows="3" required></textarea></label>` : `<div class="table-size"><label>${ht("行数（含表头）")}<input id="insert-rows" type="number" min="2" max="20" value="3" required></label><label>${ht("列数")}<input id="insert-cols" type="number" min="1" max="12" value="3" required></label></div>`;
    if (kind === 'link') (fields.querySelector('#insert-text') as HTMLInputElement).value = this.editor.actions.selectedText();
    this.dialog.querySelector('#insert-feedback')!.textContent = ''; this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>(kind === 'link' ? '#insert-href' : kind === 'table' ? '#insert-rows' : '#insert-text')!.focus();
  }
  private confirm() {
    if (!this.point || !this.dialog.querySelector('form')!.reportValidity()) return;
    const value = (id: string) => this.dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)?.value;
    try { this.editor.actions.insert(this.kind, { text: value('insert-text'), href: value('insert-href'), rows: Number(value('insert-rows')), cols: Number(value('insert-cols')) }, this.point); this.dialog.close(); this.editor.focus(); }
    catch (error) { this.dialog.querySelector('#insert-feedback')!.textContent = String(error).replace(/^Error: /, ''); }
  }
}

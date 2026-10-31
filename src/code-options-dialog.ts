import { ht, t } from '../electron/i18n.mjs';
import type { Settings } from '../shared/moye';
import { validCodeLanguage } from './code-options';

export class CodeOptionsDialog {
  private dialog = document.createElement('dialog');
  constructor(private settings: () => Settings, private apply: (patch: Partial<Settings>) => void, private focus: () => void) {
    this.dialog.id = 'code-options-dialog';
    this.dialog.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2>${ht("代码块设置")}</h2><button class="icon-button" value="cancel" aria-label="${ht("关闭代码设置")}">×</button></div>
<p>${ht("设置作用于编辑模式中的代码块；不会重新缩进已有代码。")}</p>
<label class="code-check"><input id="code-wrap" type="checkbox">${ht("长行自动换行")}</label>
<div class="table-size"><label>${ht("每级缩进空格数")}<input id="code-indent-size" type="number" min="1" max="8" step="1" required></label><label>${ht("Tab 显示列数")}<input id="code-tab-size" type="number" min="1" max="8" step="1" required></label></div>
<label>${ht("缩进字符")}<select id="code-indent-kind"><option value="spaces">${ht("Spaces · 空格")}</option><option value="tabs">${ht("Tabs · 制表符")}</option></select></label>
<label class="code-check"><input id="code-auto-indent" type="checkbox">${ht("回车自动缩进")}</label>
<label>${ht("新建代码块的语言")}<select id="code-language-mode"><option value="plain">${ht("纯文本（默认）")}</option><option value="default">${ht("指定默认语言")}</option><option value="last">${ht("沿用上次使用的语言")}</option></select></label>
<label id="code-default-label">${ht("默认语言")}<input id="code-default-language" list="code-language-list" maxlength="40" autocomplete="off" placeholder="${ht("例如 javascript、python、cpp")}"></label>
<datalist id="code-language-list">${['javascript', 'typescript', 'python', 'cpp', 'c', 'csharp', 'java', 'rust', 'go', 'json', 'html', 'css', 'sql', 'bash', 'powershell', 'yaml', 'markdown'].map(value => `<option value="${value}">`).join('')}</datalist>
<p id="code-last-language"></p><p>${ht("不改动已存在或粘贴的代码围栏。源码视图保持 Markdown 文本；HTML 跟随换行设置，PDF 打印始终换行。")}</p>
<p id="code-options-error" role="status"></p><div class="dialog-actions"><button value="cancel" class="secondary-button">${ht("取消")}</button><button type="submit" value="apply" class="primary-button">${ht("应用")}</button></div></form>`;
    document.body.append(this.dialog);
    this.input('code-language-mode').addEventListener('change', () => this.updateLanguageField());
    this.input('code-indent-kind').addEventListener('change', () => this.updateIndentField());
    this.dialog.querySelector('form')!.addEventListener('submit', event => {
      if ((event.submitter as HTMLButtonElement)?.value !== 'apply') return;
      event.preventDefault();
      if (!this.dialog.querySelector('form')!.reportValidity()) return;
      const codeLanguageMode = this.input('code-language-mode').value as Settings['codeLanguageMode'];
      const codeUseTabs = this.input('code-indent-kind').value === 'tabs';
      // Disabled fields are not covered by form validation; preserve their last valid values.
      const language = codeLanguageMode === 'default' ? this.input('code-default-language').value.trim() : this.settings().codeDefaultLanguage;
      if (!validCodeLanguage(language) || codeLanguageMode === 'default' && !language) { this.dialog.querySelector('#code-options-error')!.textContent = t("请输入语言名称（1–40 个字母、数字或 _ + . # -）。"); return; }
      this.apply({ codeWrap: this.check('code-wrap'), codeIndentSize: codeUseTabs ? this.settings().codeIndentSize : Number(this.input('code-indent-size').value), codeUseTabs, codeTabSize: Number(this.input('code-tab-size').value), codeAutoIndent: this.check('code-auto-indent'), codeLanguageMode, codeDefaultLanguage: language });
      this.dialog.close(); this.focus();
    });
  }
  private input(id: string) { return this.dialog.querySelector<HTMLInputElement>(`#${id}`)!; }
  private check(id: string) { return this.input(id).checked; }
  private updateLanguageField() { this.input('code-default-language').disabled = this.input('code-language-mode').value !== 'default'; }
  private updateIndentField() { this.input('code-indent-size').disabled = this.input('code-indent-kind').value === 'tabs'; }
  show() {
    const settings = this.settings();
    this.input('code-wrap').checked = settings.codeWrap;
    this.input('code-auto-indent').checked = settings.codeAutoIndent;
    this.input('code-indent-size').value = String(settings.codeIndentSize);
    this.input('code-tab-size').value = String(settings.codeTabSize);
    this.input('code-indent-kind').value = settings.codeUseTabs ? 'tabs' : 'spaces';
    this.input('code-language-mode').value = settings.codeLanguageMode;
    this.input('code-default-language').value = settings.codeDefaultLanguage;
    this.dialog.querySelector('#code-last-language')!.textContent = t("上次使用：{0}", settings.codeLastLanguage || t("尚未选择"));
    this.dialog.querySelector('#code-options-error')!.textContent = '';
    this.updateLanguageField(); this.updateIndentField(); this.dialog.showModal();
  }
}

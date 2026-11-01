import { ht, t, getLocale } from '../electron/i18n.mjs';
import type { Settings } from '../shared/meki';
import type { WritingEditor } from './editor';
import type { FindStatus } from './editor-search';
import { installTypingSettings } from './typing-settings';

export class WritingTools {
  private get editor() { return this.getEditor(); }
  private host: HTMLElement;
  private replacing = false;
  private typing: ReturnType<typeof installTypingSettings>;
  constructor(private getEditor: () => WritingEditor, private changeSettings: (patch: Partial<Settings>) => void, private blocked: () => boolean) {
    this.host = document.querySelector('#find-panel')!;
    this.host.innerHTML = `<div class="find-main"><input id="find-query" placeholder="${ht("查找当前文稿")}" aria-label="${ht("查找文字")}" autocomplete="off" spellcheck="false"><span id="find-count" aria-live="polite"></span><button data-writing-action="previous" aria-label="${ht("上一个匹配")}" title="${ht("上一个匹配 Shift Enter")}">↑</button><button data-writing-action="next" aria-label="${ht("下一个匹配")}" title="${ht("下一个匹配 Enter")}">↓</button><button data-writing-action="toggle-replace" aria-expanded="false">${ht("替换")}</button><button data-action="find-close" aria-label="${ht("关闭查找")}">×</button></div>
      <div class="find-options"><label><input id="find-case" type="checkbox">${ht("区分大小写")}</label><label><input id="find-word" type="checkbox">${ht("整词")}</label><label><input id="find-regex" type="checkbox">${ht("正则表达式")}</label><span id="find-scope"></span></div>
      <div id="replace-row" class="replace-row" hidden><input id="find-replacement" aria-label="${ht("替换文字")}" placeholder="${ht("替换为（正则可用 $1 或 $<名称>）")}" spellcheck="false"><button data-writing-action="replace-one">${ht("替换此项")}</button><button data-writing-action="replace-all">${ht("全部替换")}</button><button data-writing-action="undo">${ht("撤销")}</button></div>
      <div id="find-feedback" class="find-feedback" role="status"></div>`;
    this.host.querySelector('#find-query')!.addEventListener('input', () => { void this.query(); });
    this.host.querySelectorAll('.find-options input').forEach(input => input.addEventListener('change', () => { void this.query(); }));
    this.host.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); if ((event.target as HTMLElement).id === 'find-replacement') void this.replace(false); else this.editor.search.navigate(event.shiftKey ? -1 : 1); }
    });
    this.host.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-writing-action]')?.dataset.writingAction;
      if (!action || this.blocked()) return;
      if (action === 'previous' || action === 'next') this.editor.search.navigate(action === 'next' ? 1 : -1);
      if (action === 'toggle-replace') this.showReplace(!this.replacing);
      if (action === 'replace-one' || action === 'replace-all') void this.replace(action === 'replace-all');
      if (action === 'undo') { this.editor.search.undo(); this.feedback(t("已撤销上一次编辑。")); }
    });

    const group = document.createElement('div'); group.className = 'writing-settings';
    group.innerHTML = `<div class="writing-settings-title">${ht("写作辅助")}</div><label class="setting-row">${ht("打字机滚动")}<input id="typewriter" type="checkbox"></label><label class="setting-row">${ht("当前段落聚焦")}<input id="paragraph-focus" type="checkbox"></label><label class="setting-row" title="${ht("使用系统或 Chromium 词典；首次启用可能下载词典")}">${ht("拼写检查")}<input id="spellcheck" type="checkbox"></label><small>${ht("段落聚焦淡化其他文字；专注模式隐藏应用工具栏。")}</small>`;
    document.querySelector('#style-panel')!.append(group);
    this.typing = installTypingSettings(group, patch => changeSettings(patch));
    for (const [id, key] of [['typewriter', 'typewriter'], ['paragraph-focus', 'paragraphFocus'], ['spellcheck', 'spellcheck']] as const) group.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', event => changeSettings({ [key]: (event.target as HTMLInputElement).checked }));
    const selection = document.createElement('span'); selection.id = 'selection-count'; selection.hidden = true; selection.setAttribute('aria-live', 'polite');
    document.querySelector('#word-count')!.before(selection);

  }
  switchEditor(previous?: WritingEditor) { previous?.search.close(); this.editor.search.close(); if (!this.host.hidden) void this.query(false, true); }
  connect(editor: WritingEditor) {
    editor.search.onStatus = status => { if (editor === this.editor) this.status(status); };
    editor.writing.onSelection = (words, characters) => { if (editor !== this.editor) return; const selection = document.querySelector<HTMLElement>('#selection-count')!; selection.hidden = !characters; selection.textContent = t("选中 {0} 字", words.toLocaleString(getLocale())); selection.title = t("{0} 个字符（含空白）", characters.toLocaleString(getLocale())); };
  }
  private input(id: string) { return this.host.querySelector<HTMLInputElement>(`#${id}`)!; }
  private async query(select = true, internal = false) { if (!internal && this.blocked()) return; await this.editor.search.setOptions({ query: this.input('find-query').value, caseSensitive: this.input('find-case').checked, wholeWord: this.input('find-word').checked, regex: this.input('find-regex').checked }, select); }
  private showReplace(show: boolean) { this.replacing = show; this.host.querySelector<HTMLElement>('#replace-row')!.hidden = !show; this.host.querySelector('[data-writing-action="toggle-replace"]')!.setAttribute('aria-expanded', String(show)); }
  private feedback(message: string, error = false) { const feedback = this.host.querySelector<HTMLElement>('#find-feedback')!; feedback.textContent = message; feedback.classList.toggle('error', error); }
  private status(status: FindStatus) {
    this.host.querySelector('#find-count')!.textContent = status.pending ? t("查找中…") : this.input('find-query').value ? `${status.index} / ${status.total}${status.truncated ? '+' : ''}` : '';
    this.host.querySelector('#find-scope')!.textContent = this.editor.mode === 'visual' ? t("编辑区文字与公式源码") : t("全部 Markdown 源码");
    this.input('find-query').setAttribute('aria-invalid', String(Boolean(status.error)));
    this.feedback(status.error || (status.truncated ? t("超过 10,000 处匹配，请缩小查找范围后全部替换。") : ''), Boolean(status.error));
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('[data-writing-action="replace-one"],[data-writing-action="replace-all"]')) button.disabled = status.pending || Boolean(status.error) || !status.total || button.dataset.writingAction === 'replace-all' && status.truncated;
  }
  private async replace(all: boolean) { if (this.blocked()) return; const count = await this.editor.search.replace(this.input('find-replacement').value, all); if (count) this.feedback(t("已替换 {0} 处，可撤销。", count.toLocaleString(getLocale()))); }
  open(replace = false) {
    const input = this.input('find-query');
    // Read the model selection before focusing the panel; reopening from its inputs keeps the query.
    const selected = this.host.contains(document.activeElement) ? '' : this.editor.actions.selectedText();
    if (selected.trim() && !/[\r\n]/.test(selected)) {
      const query = this.input('find-regex').checked ? selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : selected;
      if (query.length <= 4096) input.value = query;
    }
    this.host.hidden = false; if (replace) this.showReplace(true);
    input.focus({ preventScroll: true }); input.select(); void this.query();
  }
  close() { this.host.hidden = true; this.editor.search.close(); }
  apply(settings: Settings) {
    this.typing.apply(settings);
    for (const [id, key] of [['typewriter', 'typewriter'], ['paragraph-focus', 'paragraphFocus'], ['spellcheck', 'spellcheck']] as const) document.querySelector<HTMLInputElement>(`#${id}`)!.checked = settings[key];
  }
}

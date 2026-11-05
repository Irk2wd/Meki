import { t, ht, getLocale } from '../electron/i18n.mjs';
import type { DocumentSnapshot, Settings } from '../shared/meki';
import type { DocumentTabs } from './document-tabs';
import './snapshots.css';

interface Hooks {
  documents: DocumentTabs;
  platform(): string;
  settings(): Settings;
  run(action: () => Promise<void>): Promise<void>;
  notify(message: string, error?: boolean): void;
}
const kinds = { manual: t("手动"), auto: t("自动"), restore: t("恢复前") };

export class SnapshotDialog {
  private dialog = document.createElement('dialog');
  private selected: DocumentSnapshot | null = null;
  private request = 0;
  private working = false;
  constructor(private hooks: Hooks) {
    this.dialog.id = 'snapshot-dialog';
    this.dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">LOCAL HISTORY</span><h2>${ht("版本历史")}</h2></div><button type="button" id="close-snapshots" class="icon-button" aria-label="${ht("关闭版本历史")}">×</button></div>
      <p class="history-help">${ht("自动保留编辑记录，包括未保存和未命名的文稿。选择版本预览，需要时恢复。")}</p>
      <p id="snapshot-protection" class="snapshot-protection"></p>
      <div class="snapshot-filter"><label for="snapshot-scope">${ht("查看")}</label><select id="snapshot-scope"><option value="current">${ht("当前文稿")}</option><option value="all">${ht("全部文稿")}</option></select><span id="snapshot-count"></span></div>
      <div class="snapshot-layout"><div id="snapshot-list" role="list" aria-label="${ht("历史版本列表")}"></div><textarea id="snapshot-preview" readonly spellcheck="false" aria-label="${ht("版本内容")}"></textarea></div>
      <p id="snapshot-status" role="status"></p><div class="dialog-actions"><button id="delete-snapshot" type="button" class="text-button" disabled>${ht("删除版本")}</button><div><button id="copy-snapshot" type="button" class="secondary-button" disabled>${ht("打开为新文稿")}</button><button id="restore-snapshot" type="button" class="primary-button" disabled>${ht("恢复到当前文稿")}</button></div></div>
      <details id="snapshot-manual"><summary>${ht("手动保留版本")}</summary><form id="snapshot-create"><input id="snapshot-label" maxlength="80" aria-label="${ht("版本名称")}" placeholder="${ht("版本名称（可选，例如：修改前）")}"><button type="submit" class="secondary-button">${ht("保留当前版本")}</button></form></details>
      <p class="snapshot-note">${ht("近期密集保留，较早版本按小时、按天合并。每篇最多 256 份 / 32 MiB，总计 128 MiB；空间不足时清理较早的自动版本，手动版本需自行删除。保留文字和图片引用，不备份图片文件。关闭文稿后可从“全部文稿”找回。")}</p>`;
    document.body.append(this.dialog);
    this.el('#close-snapshots').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      // close is queued: a previous close must not invalidate a reopened dialog.
      if (this.dialog.open) return;
      this.request++; this.selected = null;
    });
    this.dialog.addEventListener('cancel', event => { if (this.working) event.preventDefault(); });
    this.el('#snapshot-scope').addEventListener('change', () => { void this.refresh().catch(error => this.error(error)); });
    this.el('#snapshot-create').addEventListener('submit', event => {
      event.preventDefault(); void this.act(async () => {
        await this.hooks.documents.createSnapshot('manual', this.el<HTMLInputElement>('#snapshot-label').value);
        this.el<HTMLInputElement>('#snapshot-label').value = '';
        await this.refresh(); this.status(t("版本已保留，原文件保持不变。"));
      });
    });
    this.el('#restore-snapshot').addEventListener('click', () => { void this.restore(false); });
    this.el('#copy-snapshot').addEventListener('click', () => { void this.restore(true); });
    this.el('#delete-snapshot').addEventListener('click', () => {
      const selected = this.selected; if (!selected) return;
      void this.act(async () => { if (await window.meki.deleteSnapshot(selected.id)) { await this.refresh(); this.status(t("已删除快照。")); } });
    });
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }
  private status(value: string) { this.el('#snapshot-status').textContent = value; }
  private error(error: unknown) { this.status(String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '')); }
  private sameDocument(entry: DocumentSnapshot) {
    const tab = this.hooks.documents.active;
    const key = (value: string) => this.hooks.platform() === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value;
    return entry.path ? !!tab.document.path && key(entry.path) === key(tab.document.path) : tab.document.path === null && entry.tabId === tab.id;
  }
  private controls() {
    this.el<HTMLButtonElement>('#restore-snapshot').disabled = this.working || !this.selected || !this.sameDocument(this.selected);
    for (const id of ['#delete-snapshot', '#copy-snapshot']) this.el<HTMLButtonElement>(id).disabled = this.working || !this.selected;
    for (const selector of ['#snapshot-label', '#snapshot-scope', '#snapshot-create button']) this.el<HTMLInputElement>(selector).disabled = this.working;
    this.el<HTMLButtonElement>('#close-snapshots').disabled = this.working;
  }
  private async act(action: () => Promise<void>) {
    if (this.working) return;
    this.working = true; this.controls();
    try { await this.hooks.run(action); }
    catch (error) { this.error(error); }
    finally { this.working = false; this.controls(); }
  }
  async open() {
    this.el<HTMLSelectElement>('#snapshot-scope').value = 'current';
    this.el<HTMLDetailsElement>('#snapshot-manual').open = false;
    const settings = this.hooks.settings(), protection = this.el('#snapshot-protection');
    protection.dataset.enabled = String(settings.autoSnapshot);
    protection.textContent = settings.autoSnapshot ? t("自动记录已开启 · 有修改时每 {0} 秒保留版本", settings.snapshotInterval) : t("自动记录已关闭；崩溃恢复仍在后台运行。可在“文稿与保存”中开启自动记录。");
    this.dialog.showModal();
    try { await this.refresh(); } catch (error) { this.error(error); }
  }
  private async refresh() {
    const request = ++this.request;
    this.selected = null; this.controls(); this.el<HTMLTextAreaElement>('#snapshot-preview').value = '';
    this.el('#snapshot-list').replaceChildren(); this.status(t("正在读取版本…"));
    const tab = this.hooks.documents.active;
    const entries = await window.meki.listSnapshots(this.el<HTMLSelectElement>('#snapshot-scope').value === 'all' ? undefined : { path: tab.document.path, tabId: tab.id });
    if (request !== this.request || !this.dialog.open) return;
    this.el('#snapshot-count').textContent = t("{0} 个版本", entries.length);
    this.status(entries.length ? t("选择版本预览。") : this.hooks.settings().autoSnapshot ? t("还没有历史版本。继续编辑后会自动记录，无需手动创建。") : t("还没有历史版本。可在“文稿与保存”中开启自动记录，或手动保留当前版本。"));
    let day = '', first: HTMLButtonElement | undefined;
    for (const entry of entries) {
      const date = new Date(entry.createdAt).toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' });
      if (date !== day) {
        const heading = document.createElement('div'); heading.className = 'snapshot-date'; heading.textContent = date;
        this.el('#snapshot-list').append(heading); day = date;
      }
      const button = document.createElement('button'); button.type = 'button'; button.dataset.snapshotId = entry.id;
      const time = new Date(entry.createdAt).toLocaleTimeString(getLocale());
      const name = document.createElement('strong'); name.textContent = entry.label || time;
      const info = document.createElement('small'); info.textContent = `${entry.name} · ${kinds[entry.kind]}${entry.label ? ` · ${time}` : ''}`;
      button.title = entry.path || t("未命名文稿"); button.append(name, info);
      button.addEventListener('click', () => {
        if (this.working) return;
        void this.preview(entry, button);
      });
      this.el('#snapshot-list').append(button);
      first ??= button;
    }
    if (first) await this.preview(entries[0], first);
  }
  private async preview(entry: DocumentSnapshot, button: HTMLButtonElement) {
    const request = ++this.request;
    this.selected = null; this.controls(); this.el<HTMLTextAreaElement>('#snapshot-preview').value = ''; this.status(t("正在读取内容…"));
    try {
      const result = await window.meki.readSnapshot(entry.id);
      if (request !== this.request || !this.dialog.open) return;
      this.selected = result.snapshot; this.el<HTMLTextAreaElement>('#snapshot-preview').value = result.content;
      this.el('#snapshot-list').querySelectorAll('button').forEach(node => node.classList.toggle('active', node === button));
      this.controls(); this.status(this.sameDocument(entry) ? t("恢复前会保留当前内容。恢复后自动保存暂停，检查后请手动保存。") : t("这是其他文稿的版本，可以打开为新文稿。"));
    } catch (error) { if (request === this.request) this.error(error); }
  }
  private async restore(copy: boolean) {
    const selected = this.selected; if (!selected) return;
    await this.act(async () => {
      const result = await window.meki.readSnapshot(selected.id);
      if (copy) await this.hooks.documents.open({ path: null, revision: null, name: t("历史版本 · {0}", result.snapshot.name), content: result.content }, true);
      else {
        if (!this.sameDocument(result.snapshot)) throw new Error(t("文稿已切换，请重新打开版本历史。"));
        await this.hooks.documents.createSnapshot('restore', t("恢复版本前"));
        await this.hooks.documents.restoreBuffer(result.content);
      }
      this.dialog.close(); this.hooks.notify(copy ? t("已打开为未保存的新文稿。") : t("已恢复历史版本，并保留恢复前内容。检查后请手动保存。"));
    });
  }
}

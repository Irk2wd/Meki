import { t, ht, getLocale } from '../electron/i18n.mjs';
import type { DocumentSnapshot } from '../shared/moye';
import type { DocumentTabs } from './document-tabs';
import './snapshots.css';

interface Hooks {
  documents: DocumentTabs;
  platform(): string;
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
    this.dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">LOCAL SNAPSHOTS</span><h2>${ht("文稿快照")}</h2></div><button type="button" id="close-snapshots" class="icon-button" aria-label="${ht("关闭快照")}">×</button></div>
      <p class="history-help">${ht("保留编辑区的内容，也支持未命名文稿。恢复前会先创建快照，再恢复到编辑区；原文件等待你手动保存。")}</p>
      <form id="snapshot-create"><input id="snapshot-label" maxlength="80" aria-label="${ht("快照名称")}" placeholder="${ht("快照名称（可选，例如：修改前）")}"><button type="submit" class="secondary-button">${ht("创建快照")}</button></form>
      <div class="snapshot-filter"><label for="snapshot-scope">${ht("查看")}</label><select id="snapshot-scope"><option value="current">${ht("当前文稿")}</option><option value="all">${ht("全部文稿")}</option></select><span id="snapshot-count"></span></div>
      <div class="snapshot-layout"><div id="snapshot-list" role="list" aria-label="${ht("快照列表")}"></div><textarea id="snapshot-preview" readonly spellcheck="false" aria-label="${ht("快照内容")}"></textarea></div>
      <p id="snapshot-status" role="status"></p><div class="dialog-actions"><button id="delete-snapshot" type="button" class="text-button" disabled>${ht("删除快照")}</button><div><button id="copy-snapshot" type="button" class="secondary-button" disabled>${ht("打开为新文稿")}</button><button id="restore-snapshot" type="button" class="primary-button" disabled>${ht("恢复到当前文稿")}</button></div></div>
      <p class="snapshot-note">${ht("每篇最多 20 份 / 32 MiB，总计 128 MiB。空间不足时清理旧自动快照，手动快照需自行删除。快照保留文字和图片引用，不备份图片文件；关闭文稿后仍可从“全部文稿”找回。")}</p>`;
    document.body.append(this.dialog);
    this.el('#close-snapshots').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => { this.request++; this.selected = null; });
    this.dialog.addEventListener('cancel', event => { if (this.working) event.preventDefault(); });
    this.el('#snapshot-scope').addEventListener('change', () => { void this.refresh().catch(error => this.error(error)); });
    this.el('#snapshot-create').addEventListener('submit', event => {
      event.preventDefault(); void this.act(async () => {
        await this.hooks.documents.createSnapshot('manual', this.el<HTMLInputElement>('#snapshot-label').value);
        this.el<HTMLInputElement>('#snapshot-label').value = '';
        await this.refresh(); this.status(t("快照已保存，原文件保持不变。"));
      });
    });
    this.el('#restore-snapshot').addEventListener('click', () => { void this.restore(false); });
    this.el('#copy-snapshot').addEventListener('click', () => { void this.restore(true); });
    this.el('#delete-snapshot').addEventListener('click', () => {
      const selected = this.selected; if (!selected) return;
      void this.act(async () => { if (await window.moye.deleteSnapshot(selected.id)) { await this.refresh(); this.status(t("已删除快照。")); } });
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
    this.dialog.showModal();
    try { await this.refresh(); } catch (error) { this.error(error); }
  }
  private async refresh() {
    const request = ++this.request;
    this.selected = null; this.controls(); this.el<HTMLTextAreaElement>('#snapshot-preview').value = '';
    this.el('#snapshot-list').replaceChildren(); this.status(t("正在读取快照…"));
    const tab = this.hooks.documents.active;
    const entries = await window.moye.listSnapshots(this.el<HTMLSelectElement>('#snapshot-scope').value === 'all' ? undefined : { path: tab.document.path, tabId: tab.id });
    if (request !== this.request || !this.dialog.open) return;
    this.el('#snapshot-count').textContent = t("{0} 份快照", entries.length);
    this.status(entries.length ? t("选择快照预览。") : t("还没有快照。可以创建一份，或继续写作，等待定期快照。"));
    for (const entry of entries) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.snapshotId = entry.id;
      const name = document.createElement('strong'); name.textContent = entry.label || t("{0}快照", kinds[entry.kind]);
      const info = document.createElement('small'); info.textContent = `${entry.name} · ${kinds[entry.kind]} · ${new Date(entry.createdAt).toLocaleString(getLocale())}`;
      button.title = entry.path || t("未命名文稿"); button.append(name, info);
      button.addEventListener('click', () => {
        if (this.working) return;
        const request = ++this.request;
        this.selected = null; this.controls(); this.el<HTMLTextAreaElement>('#snapshot-preview').value = ''; this.status(t("正在读取内容…"));
        void window.moye.readSnapshot(entry.id).then(result => {
          if (request !== this.request || !this.dialog.open) return;
          this.selected = result.snapshot; this.el<HTMLTextAreaElement>('#snapshot-preview').value = result.content;
          this.el('#snapshot-list').querySelectorAll('button').forEach(node => node.classList.toggle('active', node === button));
          this.controls(); this.status(this.sameDocument(entry) ? t("恢复前会保留当前内容。恢复后自动保存暂停，检查后请手动保存。") : t("这是其他文稿的快照，可以打开为新文稿。"));
        }).catch(error => { if (request === this.request) this.error(error); });
      });
      this.el('#snapshot-list').append(button);
    }
  }
  private async restore(copy: boolean) {
    const selected = this.selected; if (!selected) return;
    await this.act(async () => {
      const result = await window.moye.readSnapshot(selected.id);
      if (copy) await this.hooks.documents.open({ path: null, revision: null, name: t("快照 · {0}", result.snapshot.name), content: result.content }, true);
      else {
        if (!this.sameDocument(result.snapshot)) throw new Error(t("文稿已切换，请重新打开快照。"));
        await this.hooks.documents.createSnapshot('restore', t("恢复快照前"));
        await this.hooks.documents.restoreBuffer(result.content);
      }
      this.dialog.close(); this.hooks.notify(copy ? t("已打开为未保存的新文稿。") : t("已恢复快照，并保留恢复前内容。检查后请手动保存。"));
    });
  }
}

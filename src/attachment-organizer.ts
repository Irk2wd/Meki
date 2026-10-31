import { t, ht } from '../electron/i18n.mjs';
import type { DocumentFile, AttachmentPlan } from '../shared/moye';
import type { WritingEditor } from './editor';
import { scanAttachmentImages, attachmentEdits } from './attachment-markdown';
import './attachment-organizer.css';

interface Hooks {
  document(): DocumentFile;
  activeId(): string | null;
  editor(): WritingEditor;
  run(action: () => Promise<void>): Promise<void>;
  pause(): void;
  persist(): Promise<void>;
  notify(message: string, error?: boolean): void;
}

export class AttachmentOrganizer {
  private dialog: HTMLDialogElement;
  constructor(private hooks: Hooks) {
    const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'theme-edit-button';
    entry.dataset.action = 'organize-attachments'; entry.textContent = t("整理图片附件…");
    document.querySelector('#lifecycle-settings [data-action="history"]')!.before(entry);
    this.dialog = document.createElement('dialog'); this.dialog.id = 'attachment-dialog';
    this.dialog.setAttribute('aria-labelledby', 'attachment-title');
    this.dialog.innerHTML = `<form method="dialog"><div class="dialog-heading"><div><span class="eyebrow">LOCAL ATTACHMENTS</span><h2 id="attachment-title">${ht("整理图片附件")}</h2></div><button value="cancel" class="icon-button" aria-label="${ht("取消整理")}">×</button></div><p id="attachment-summary" role="status"></p><div class="attachment-target"><span>${ht("目标文件夹")}</span><code id="attachment-target"></code></div><p id="attachment-details"></p><p class="attachment-help">${ht("复制本地与嵌入图片，将当前文稿的图片地址改为相对路径。原图片保留；网络图片、普通链接与其他文稿保持原样。")}</p><p class="attachment-help">${ht("完成后文稿仍未保存，自动保存会暂停。检查后请手动保存；撤销只还原文稿引用，不删除已复制的图片。")}</p><div class="dialog-actions"><button value="cancel">${ht("取消")}</button><button id="attachment-confirm" value="confirm" class="primary-button">${ht("复制并更新引用")}</button></div></form>`;
    document.body.append(this.dialog);
  }
  private confirm(plan: AttachmentPlan, references: number) {
    this.dialog.querySelector('#attachment-summary')!.textContent = t("将复制 {0} 张图片，更新当前文稿的图片引用。", plan.count);
    this.dialog.querySelector('#attachment-target')!.textContent = plan.target;
    const size = plan.bytes >= 1024 * 1024 ? `${(plan.bytes / 1024 / 1024).toFixed(2)} MiB` : plan.bytes >= 1024 ? `${(plan.bytes / 1024).toFixed(1)} KiB` : `${plan.bytes} B`;
    this.dialog.querySelector('#attachment-details')!.textContent = t("识别到 {0} 处图片引用 · {1} 张已在目标目录 · {2} 个网络地址跳过 · 合计 {3}", references, plan.reused, plan.remote, size);
    this.dialog.querySelector<HTMLButtonElement>('#attachment-confirm')!.disabled = plan.count + plan.reused === 0;
    this.dialog.returnValue = 'cancel';
    const answer = new Promise<boolean>(resolve => this.dialog.addEventListener('close', () => resolve(this.dialog.returnValue === 'confirm'), { once: true }));
    this.dialog.showModal(); return answer;
  }
  async open() {
    try {
      await this.hooks.run(async () => {
        const editor = this.hooks.editor(); editor.flush();
        const snapshot = { ...this.hooks.document() }, tabId = this.hooks.activeId();
        if (!snapshot.path || !snapshot.revision) throw new Error(t("先保存当前文稿，再整理图片附件。"));
        const images = scanAttachmentImages(snapshot.content);
        if (!images.length) { this.hooks.notify(t("当前文稿中没有可整理的图片引用。")); return; }
        document.querySelector<HTMLElement>('#lifecycle-settings')!.hidden = true;
        let plan: AttachmentPlan | null = await window.moye.prepareAttachments({ documentPath: snapshot.path, revision: snapshot.revision, sources: [...new Set(images.map(image => image.source))] });
        let keep = false;
        const unchanged = () => {
          editor.flush(); const current = this.hooks.document();
          if (this.hooks.activeId() !== tabId || current.path !== snapshot.path || current.revision !== snapshot.revision || current.content !== snapshot.content) throw new Error(t("文稿在整理期间已变化，未更新图片引用，请重试。"));
        };
        try {
          if (!await this.confirm(plan, images.length)) return;
          unchanged();
          let mapping;
          try { mapping = await window.moye.commitAttachments(plan.id); }
          catch (error) { plan = null; throw error; } // main already rolled back this failed copy.
          unchanged();
          const edits = attachmentEdits(snapshot.content, images, mapping);
          if (!edits.length) { this.hooks.notify(t("图片已经使用目标附件目录中的相对路径。")); return; }
          editor.replaceMarkdownRanges(snapshot.content, edits);
          keep = true; this.hooks.pause();
          await window.moye.finishAttachments(plan.id, true); plan = null;
          await this.hooks.persist();
          this.hooks.notify(t("已更新 {0} 处图片引用；原图片保留，请检查后手动保存。", edits.length));
        } finally {
          if (this.dialog.open) this.dialog.close();
          if (plan) await window.moye.finishAttachments(plan.id, keep);
        }
      });
    } catch (error) { this.hooks.notify(String(error), true); }
  }
}

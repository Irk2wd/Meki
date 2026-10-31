import { ht, t } from '../electron/i18n.mjs';
import type { AttachmentPlan, DocumentFile, Settings } from '../shared/moye';
import type { WritingEditor } from './editor';
import { scanAttachmentImages, attachmentEdits } from './attachment-markdown';
import './image-actions.css';

interface Hooks {
  editor(): WritingEditor; document(): DocumentFile; activeId(): string | null; settings(): Settings;
  run(action: () => Promise<void>): Promise<void>; pause(): void; persist(): Promise<void>;
  upload(source: string): Promise<void>; notify(message: string, error?: boolean): void;
}
export class ImageActions {
  private menu = document.createElement('div');
  private dialog = document.createElement('dialog');
  private selected: { source: string; tab: string | null } | null = null;
  private running = false; private canceled = false;
  constructor(private hooks: Hooks) {
    this.menu.id = 'image-actions-menu'; this.menu.className = 'image-actions-menu'; this.menu.hidden = true; this.menu.setAttribute('role', 'menu');
    this.menu.innerHTML = `<button type="button" data-image-action="upload" role="menuitem">${ht("上传这张图片到 PicGo…")}</button><button type="button" data-image-action="copy" role="menuitem">${ht("复制图片并更新引用…")}</button><button type="button" data-image-action="download" role="menuitem">${ht("下载图片到本地…")}</button>`;
    this.dialog.id = 'image-copy-dialog'; this.dialog.setAttribute('aria-labelledby', 'image-copy-title');
    this.dialog.innerHTML = `<form><div class="dialog-heading"><h2 id="image-copy-title">${ht("保存图片副本")}</h2><button type="button" data-image-cancel aria-label="${ht("取消图片操作")}">×</button></div><p id="image-copy-source"></p><p>${ht("更新当前文稿中此图片的所有引用，保留说明与尺寸。原图保留，完成后请手动保存；撤销只还原文稿引用。")}</p><label>${ht("目录基准")}<select id="image-copy-base"><option value="document">${ht("当前文稿")}</option><option value="workspace">${ht("当前工作区")}</option></select></label><label>${ht("相对目录")}<input id="image-copy-directory" required maxlength="512" /></label><label>${ht("副本名称（可留空）")}<input id="image-copy-name" maxlength="240" placeholder="${ht("自动生成唯一名称")}" /></label><p id="image-copy-status" role="status" aria-live="polite"></p><div class="dialog-actions"><button type="button" data-image-cancel>${ht("取消")}</button><button class="primary-button" type="submit">${ht("保存副本并更新引用")}</button></div></form>`;
    document.body.append(this.menu, this.dialog);
    document.addEventListener('contextmenu', event => {
      const target = event.target instanceof Element ? event.target : null;
      const image = target && !target.closest('input,textarea') ? target.closest<HTMLImageElement>('.ProseMirror img') || target.closest('.moye-image-block')?.querySelector('img') : null;
      if (image && this.open(image, event.clientX, event.clientY)) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    const refresh = () => document.querySelectorAll<HTMLElement>('.moye-image-block .operation').forEach(operation => {
      if (operation.querySelector('.image-more-actions')) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'image-more-actions'; button.textContent = '⋯'; button.title = t("图片操作"); button.setAttribute('aria-label', t("图片操作"));
      button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); const image = operation.closest('.moye-image-block')?.querySelector('img'); if (image) { const box = button.getBoundingClientRect(); this.open(image, box.left, box.bottom); } });
      operation.append(button);
    });
    new MutationObserver(refresh).observe(document.querySelector('.main-area')!, { childList: true, subtree: true }); refresh();
    document.addEventListener('click', event => { if (!this.menu.contains(event.target as Node)) this.menu.hidden = true; });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') this.menu.hidden = true; });
    this.menu.addEventListener('click', event => {
      const action = (event.target as Element).closest<HTMLElement>('[data-image-action]')?.dataset.imageAction;
      if (!action || !this.selected) return; this.menu.hidden = true;
      if (this.hooks.activeId() !== this.selected.tab) return;
      if (action === 'upload') void this.hooks.upload(this.selected.source);
      else this.show(action === 'download');
    });
    this.dialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.execute(); });
    this.dialog.addEventListener('click', event => { if ((event.target as Element).closest('[data-image-cancel]')) this.cancel(); });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.cancel(); });
  }
  private open(image: HTMLImageElement, x: number, y: number) {
    if (document.body.classList.contains('is-busy') || document.querySelector('dialog[open]')) return false;
    const source = this.hooks.editor().imageSourceAt(image); if (!source) return false;
    this.selected = { source, tab: this.hooks.activeId() };
    const remote = /^https?:\/\//i.test(source);
    this.menu.querySelector<HTMLElement>('[data-image-action="upload"]')!.hidden = remote;
    this.menu.querySelector<HTMLElement>('[data-image-action="copy"]')!.hidden = remote;
    this.menu.querySelector<HTMLElement>('[data-image-action="download"]')!.hidden = !remote;
    this.menu.hidden = false; this.menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 240))}px`; this.menu.style.top = `${Math.max(8, Math.min(y, innerHeight - this.menu.offsetHeight - 8))}px`;
    return true;
  }
  private show(download: boolean) {
    const settings = this.hooks.settings(); this.canceled = false; this.dialog.dataset.download = String(download);
    this.dialog.querySelector('#image-copy-title')!.textContent = download ? t("下载图片到本地") : t("保存图片副本");
    this.dialog.querySelector('#image-copy-source')!.textContent = this.selected!.source.startsWith('data:') ? t("嵌入图片") : this.selected!.source;
    this.dialog.querySelector<HTMLSelectElement>('#image-copy-base')!.value = settings.imageDirectoryBase;
    this.dialog.querySelector<HTMLInputElement>('#image-copy-directory')!.value = settings.imageDirectory;
    this.dialog.querySelector<HTMLInputElement>('#image-copy-name')!.value = '';
    this.dialog.querySelector('#image-copy-status')!.textContent = '';
    this.dialog.showModal();
  }
  private cancel() {
    this.canceled = true;
    if (this.running) { this.dialog.querySelector('#image-copy-status')!.textContent = t("正在取消…"); void window.moye.cancelImageDownload(); }
    else this.dialog.close();
  }
  private async execute() {
    if (this.running || !this.selected || !this.dialog.querySelector('form')!.reportValidity()) return;
    const selected = this.selected, destination = { base: this.dialog.querySelector<HTMLSelectElement>('#image-copy-base')!.value as 'document' | 'workspace', directory: this.dialog.querySelector<HTMLInputElement>('#image-copy-directory')!.value };
    const name = this.dialog.querySelector<HTMLInputElement>('#image-copy-name')!.value.trim();
    this.running = true; this.canceled = false;
    this.dialog.querySelectorAll<HTMLInputElement>('input,select,button[type="submit"]').forEach(control => { control.disabled = true; });
    try {
      await this.hooks.run(async () => {
        const editor = this.hooks.editor(); editor.flush(); const snapshot = { ...this.hooks.document() };
        if (this.hooks.activeId() !== selected.tab || !snapshot.path || !snapshot.revision) throw new Error(t("请先保存当前文稿，再操作图片。"));
        const images = scanAttachmentImages(snapshot.content).filter(image => image.source === selected.source);
        if (!images.length) throw new Error(t("这张图片已变化，请重新选择。"));
        const unchanged = () => { editor.flush(); const current = this.hooks.document(); if (this.canceled || this.hooks.activeId() !== selected.tab || current.path !== snapshot.path || current.revision !== snapshot.revision || current.content !== snapshot.content) throw new Error(t("图片操作已取消或文稿已变化，未更新引用。")); };
        let plan: AttachmentPlan | null = null, keep = false;
        try {
          this.dialog.querySelector('#image-copy-status')!.textContent = this.dialog.dataset.download === 'true' ? t("正在下载图片…") : t("正在检查图片…");
          plan = await window.moye.prepareAttachments({ documentPath: snapshot.path, revision: snapshot.revision, sources: [selected.source], destination, ...(name ? { name } : {}), download: this.dialog.dataset.download === 'true' });
          unchanged(); let mapping;
          try { mapping = await window.moye.commitAttachments(plan.id); } catch (error) { plan = null; throw error; }
          unchanged(); const edits = attachmentEdits(snapshot.content, images, mapping);
          if (edits.length) { editor.replaceMarkdownRanges(snapshot.content, edits); keep = true; this.hooks.pause(); }
          await window.moye.finishAttachments(plan.id, keep); plan = null;
          if (keep) await this.hooks.persist();
          this.dialog.close(); this.hooks.notify(t("已更新 {0} 处图片引用；原图保留，请检查后手动保存。", edits.length));
        } finally { if (plan) await window.moye.finishAttachments(plan.id, keep); }
      });
    } catch (error) { this.dialog.querySelector('#image-copy-status')!.textContent = String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, ''); if (this.canceled) this.dialog.close(); }
    finally { this.running = false; this.dialog.querySelectorAll<HTMLInputElement>('input,select,button[type="submit"]').forEach(control => { control.disabled = false; }); }
  }
}

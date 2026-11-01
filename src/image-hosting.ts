import { t, ht } from '../electron/i18n.mjs';
import type { DocumentFile, ImageInput, ImageUploadPlan, Settings } from '../shared/meki';
import type { WritingEditor } from './editor';
import { scanAttachmentImages, attachmentEdits } from './attachment-markdown';
import './image-hosting.css';

interface Hooks {
  document(): DocumentFile;
  activeId(): string | null;
  editor(): WritingEditor;
  settings(): Settings;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  run(action: () => Promise<void>): Promise<void>;
  pause(): void;
  persist(): Promise<void>;
  notify(message: string, error?: boolean): void;
}
const message = (error: unknown) => String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '');

export class ImageHostingDialog {
  private settingsDialog = document.createElement('dialog');
  private uploadDialog = document.createElement('dialog');
  private insertDialog = document.createElement('dialog');
  private checking = false;
  private uploading = false;
  private canceled = false;
  constructor(private hooks: Hooks) {
    const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'more-tools image-host-entry';
    entry.dataset.action = 'image-hosting'; entry.textContent = t("图床"); entry.title = t("PicGo 图床设置与上传");
    document.querySelector('[data-action="image"]')!.after(entry);
    this.settingsDialog.id = 'image-host-dialog'; this.settingsDialog.setAttribute('aria-labelledby', 'image-host-title');
    this.settingsDialog.innerHTML = `<form><div class="dialog-heading"><div><span class="eyebrow">IMAGES · PICGO</span><h2 id="image-host-title">${ht("图床")}</h2></div><button type="button" data-host="close" class="icon-button" aria-label="${ht("关闭图床设置")}">×</button></div>
      <p>${ht("通过本机 PicGo 上传图片。先在 PicGo 中配置图床并开启 PicGo Server；账号和密钥由 PicGo 管理。")}</p>
      <label for="picgo-port">${ht("PicGo Server 端口")}</label><input id="picgo-port" type="number" min="1" max="65535" step="1" required />
      <p class="image-host-note">${ht("默认 36677，仅连接本机。检测连接不上传图片，也不读取剪贴板。")}</p>
      <label class="image-host-toggle"><input id="image-auto-upload" type="checkbox" /> ${ht("插入图片时自动上传到 PicGo")}</label>
      <p class="image-host-note">${ht("开启后，粘贴、拖入或选择的图片会上传到 PicGo 当前图床。失败时改走本地附件保存流程；已有图片和网络图片不会自动上传。")}</p>
      <label for="image-directory-base">${ht("本地图片目录")}</label><select id="image-directory-base"><option value="document">${ht("相对于文稿")}</option><option value="workspace">${ht("相对于工作区")}</option></select>
      <input id="image-directory" type="text" maxlength="512" required aria-label="${ht("图片相对目录")}" />
      <p class="image-host-note">${ht("可用 $&#123;filename&#125; 代表文稿名，例如 images/$&#123;filename&#125;。仅影响之后插入、整理或下载的图片；原有图片保持原样。")}</p>
      <p id="image-host-status" role="status" aria-live="polite"></p>
      <div class="dialog-actions"><button type="button" data-host="upload">${ht("上传文稿图片…")}</button><button type="button" data-host="check">${ht("检测连接")}</button><button type="submit" data-host="save" class="primary-button">${ht("保存设置")}</button></div></form>`;
    this.uploadDialog.id = 'image-upload-dialog'; this.uploadDialog.setAttribute('aria-labelledby', 'image-upload-title');
    this.uploadDialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">IMAGES · PICGO</span><h2 id="image-upload-title">${ht("上传文稿图片")}</h2></div><button type="button" data-upload="cancel" class="icon-button" aria-label="${ht("取消上传")}">×</button></div>
      <p id="image-upload-summary"></p><ul id="image-upload-files"></ul>
      <p class="image-host-note">${ht("将本地与嵌入图片交给 PicGo 上传，网络图片跳过。全部成功后才更新文稿地址，保留说明、标题和尺寸；原图片保留。")}</p>
      <p class="image-host-note">${ht("完成后请检查并手动保存。撤销只恢复文稿引用，不删除图床上的图片；取消等待也不能撤回 PicGo 已开始的上传。")}</p>
      <p id="image-upload-status" role="status" aria-live="polite"></p><progress id="image-upload-progress" aria-label="${ht("PicGo 正在上传")}" hidden></progress>
      <div class="dialog-actions"><button type="button" data-upload="cancel">${ht("取消")}</button><button type="button" data-upload="confirm" class="primary-button">${ht("开始上传")}</button></div>`;
    this.insertDialog.id = 'image-insert-upload'; this.insertDialog.setAttribute('aria-labelledby', 'image-insert-title');
    this.insertDialog.innerHTML = `<h2 id="image-insert-title">${ht("正在上传到 PicGo")}</h2><p id="image-insert-status" role="status"></p><progress aria-label="${ht("PicGo 正在上传")}"></progress><p class="image-host-note">${ht("取消等待后会改为本地附件；PicGo 可能仍在处理已发送的上传。")}</p><div class="dialog-actions"><button type="button">${ht("取消等待")}</button></div>`;
    this.insertDialog.querySelector('button')!.addEventListener('click', () => { void this.cancel(); });
    this.insertDialog.addEventListener('cancel', event => { event.preventDefault(); void this.cancel(); });
    document.body.append(this.settingsDialog, this.uploadDialog, this.insertDialog);
    this.settingsDialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    this.settingsDialog.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-host]')?.dataset.host;
      if (action === 'close' && !this.checking) this.settingsDialog.close();
      if (action === 'check') void this.save(true);
      if (action === 'upload') void this.uploadFromSettings();
    });
    this.settingsDialog.addEventListener('cancel', event => { if (this.checking) event.preventDefault(); });
    this.uploadDialog.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest<HTMLElement>('[data-upload]')?.dataset.upload === 'cancel') void this.cancel();
    });
    this.uploadDialog.addEventListener('cancel', event => { event.preventDefault(); void this.cancel(); });
  }
  open() {
    if (this.settingsDialog.open) return;
    this.settingsDialog.querySelector<HTMLInputElement>('#picgo-port')!.value = String(this.hooks.settings().picgoPort);
    this.settingsDialog.querySelector<HTMLInputElement>('#image-auto-upload')!.checked = this.hooks.settings().imageAutoUpload;
    this.settingsDialog.querySelector<HTMLSelectElement>('#image-directory-base')!.value = this.hooks.settings().imageDirectoryBase;
    this.settingsDialog.querySelector<HTMLInputElement>('#image-directory')!.value = this.hooks.settings().imageDirectory;
    this.settingsDialog.querySelector('#image-host-status')!.textContent = '';
    this.settingsDialog.showModal();
  }
  private async save(check = false) {
    if (this.checking || !this.settingsDialog.querySelector('form')!.reportValidity()) return false;
    this.checking = true;
    const buttons = this.settingsDialog.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(button => { button.disabled = true; });
    const feedback = this.settingsDialog.querySelector('#image-host-status')!;
    try {
      await this.hooks.saveSettings({ picgoPort: Number(this.settingsDialog.querySelector<HTMLInputElement>('#picgo-port')!.value), imageAutoUpload: this.settingsDialog.querySelector<HTMLInputElement>('#image-auto-upload')!.checked,
        imageDirectoryBase: this.settingsDialog.querySelector<HTMLSelectElement>('#image-directory-base')!.value as 'document' | 'workspace', imageDirectory: this.settingsDialog.querySelector<HTMLInputElement>('#image-directory')!.value });
      feedback.textContent = check ? t("正在检测 PicGo…") : t("设置已保存。");
      if (check) feedback.textContent = await window.meki.checkImageHost();
      return true;
    } catch (error) { feedback.textContent = message(error); return false; }
    finally { this.checking = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  private async uploadFromSettings() {
    if (!await this.save()) return;
    this.settingsDialog.close(); await this.uploadDocument();
  }
  private async cancel() {
    if (!this.uploading) { this.uploadDialog.close('cancel'); return; }
    this.canceled = true;
    this.uploadDialog.querySelector('#image-upload-status')!.textContent = t("正在取消等待…");
    this.insertDialog.querySelector('#image-insert-status')!.textContent = t("正在取消等待…");
    try { await window.meki.cancelImageUpload(); } catch (error) { this.hooks.notify(message(error), true); }
  }
  async uploadNew(images: ImageInput[]) {
    this.canceled = false; this.uploading = true;
    this.insertDialog.querySelector('#image-insert-status')!.textContent = t("等待 PicGo 上传 {0} 张图片…", images.length);
    this.insertDialog.showModal();
    try {
      const urls = await window.meki.uploadImages(images);
      if (this.canceled) throw new Error(t("已取消等待。"));
      return urls;
    } finally { this.uploading = false; this.insertDialog.close(); }
  }
  private confirm(plan: ImageUploadPlan) {
    this.canceled = false;
    this.uploadDialog.querySelector('#image-upload-summary')!.textContent = t("{0} 张不同图片 · {1} MiB · 跳过 {2} 个网络地址", plan.count, (plan.bytes / 1024 / 1024).toFixed(2), plan.remote);
    const list = this.uploadDialog.querySelector('#image-upload-files')!; list.replaceChildren();
    for (const name of plan.names) { const item = document.createElement('li'); item.textContent = name; list.append(item); }
    this.uploadDialog.querySelector('#image-upload-status')!.textContent = '';
    this.uploadDialog.querySelector<HTMLElement>('#image-upload-progress')!.hidden = true;
    const button = this.uploadDialog.querySelector<HTMLButtonElement>('[data-upload="confirm"]')!; button.disabled = plan.count === 0; button.hidden = false;
    this.uploadDialog.showModal();
    return new Promise<boolean>(resolve => {
      const accept = () => { cleanup(); resolve(true); };
      const closed = () => { cleanup(); resolve(false); };
      const cleanup = () => { button.removeEventListener('click', accept); this.uploadDialog.removeEventListener('close', closed); };
      button.addEventListener('click', accept); this.uploadDialog.addEventListener('close', closed);
    });
  }
  async uploadDocument(source?: string) {
    try {
      await this.hooks.run(async () => {
        const editor = this.hooks.editor(); editor.flush();
        const snapshot = { ...this.hooks.document() }, tab = this.hooks.activeId();
        if (!snapshot.path || !snapshot.revision) throw new Error(t("先保存当前文稿，再上传已有图片。"));
        const images = scanAttachmentImages(snapshot.content).filter(image => source === undefined || image.source === source);
        if (!images.length) { this.hooks.notify(t("当前文稿没有图片引用。")); return; }
        const unchanged = () => { editor.flush(); const current = this.hooks.document();
          if (tab !== this.hooks.activeId() || current.path !== snapshot.path || current.revision !== snapshot.revision || current.content !== snapshot.content) throw new Error(t("文稿在上传期间已变化，未替换图片地址。")); };
        try {
          const plan = await window.meki.prepareImageUpload({ documentPath: snapshot.path, revision: snapshot.revision, sources: [...new Set(images.map(image => image.source))] });
          if (!await this.confirm(plan)) return;
          unchanged(); this.uploading = true;
          this.uploadDialog.querySelector<HTMLButtonElement>('[data-upload="confirm"]')!.hidden = true;
          this.uploadDialog.querySelector<HTMLElement>('#image-upload-progress')!.hidden = false;
          this.uploadDialog.querySelector('#image-upload-status')!.textContent = t("等待 PicGo 上传…");
          const mapping = await window.meki.uploadPreparedImages(plan.id);
          unchanged(); if (this.canceled) throw new Error(t("已取消替换图片地址，文稿保持原样。"));
          const edits = attachmentEdits(snapshot.content, images, mapping.map(item => ({ source: item.source, relativePath: item.url })));
          if (edits.length) { editor.replaceMarkdownRanges(snapshot.content, edits); this.hooks.pause(); await this.hooks.persist(); }
          this.hooks.notify(t("已上传 {0} 张图片，更新 {1} 处引用；请检查后手动保存。", plan.count, edits.length));
        } finally {
          this.uploading = false;
          if (this.uploadDialog.open) this.uploadDialog.close();
          await window.meki.abandonImageUpload();
        }
      });
    } catch (error) { this.hooks.notify(message(error), true); }
  }
}

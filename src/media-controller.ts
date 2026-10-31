import { t } from '../electron/i18n.mjs';
import type { DocumentFile, ImageInput } from '../shared/moye';
import type { WritingEditor } from './editor';
const extensions = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const mimeExtension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/svg+xml': 'svg' };
async function readFiles(files: File[]): Promise<ImageInput[]> {
  if (!files.length || files.length > 32) throw new Error(t("一次可添加 1–32 张图片。"));
  if (files.some(file => file.size === 0 || file.size > 20 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024) throw new Error(t("每张图片不超过 20 MiB，每批不超过 80 MiB。"));
  const result = [];
  for (const file of files) {
    const name = extensions.test(file.name) ? file.name : mimeExtension[file.type] ? `${file.name || t("粘贴图片")}.${mimeExtension[file.type]}` : '';
    if (!name) throw new Error(t("请选择 PNG、JPEG、GIF、WebP、AVIF、BMP、ICO 或 SVG 图片。"));
    result.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return result;
}
interface MediaHost { current(): DocumentFile; documentId(): number; blocked(): boolean; autoUpload(): boolean; upload(images: ImageInput[]): Promise<string[]>; save(): Promise<boolean>; run(task: () => Promise<void>): Promise<void>; notify(message: string, error?: boolean): void }
export class MediaController {
  private get editor() { return this.getEditor(); }
  constructor(private getEditor: () => WritingEditor, private host: MediaHost) {
    document.addEventListener('paste', event => {
      if (!(event.target as Element)?.closest('.document-scroll')) return;
      const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/') || extensions.test(file.name));
      if (!files.length) return;
      event.preventDefault(); event.stopImmediatePropagation(); void this.add(() => readFiles(files));
    }, true);
    document.addEventListener('drop', event => {
      if (!(event.target as Element)?.closest('.document-scroll')) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length || files.some(file => !file.type.startsWith('image/') && !extensions.test(file.name))) return;
      event.preventDefault(); event.stopImmediatePropagation(); void this.add(() => readFiles(files), { x: event.clientX, y: event.clientY });
    }, true);

  }
  connect(editor: WritingEditor, visual: HTMLElement) {
    editor.uploadImage = file => editor === this.editor ? this.uploadForNode(file) : Promise.resolve('');
    const observer = new MutationObserver(() => editor.actions.syncImageAlt()); observer.observe(visual, { childList: true, subtree: true });
    return () => observer.disconnect();
  }
  choose() { return this.add(() => window.moye.chooseImages()); }
  private async add(load: () => Promise<ImageInput[] | null>, coordinates?: { x: number; y: number }) {
    if (this.host.blocked()) return;
    const point = this.editor.actions.captureImages(coordinates), id = this.host.documentId();
    await this.host.run(async () => {
      const images = await load(); if (!images?.length) return;
      let uploadError = '';
      if (this.host.autoUpload()) {
        let paths: string[] | null = null;
        try { paths = await this.host.upload(images); }
        catch (error) { uploadError = String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, ''); }
        if (paths) {
          if (id !== this.host.documentId() || !this.editor.actions.isCurrent(point)) throw new Error(t("文稿已改变，未插入图床地址。"));
          this.editor.actions.images(paths.map((src, index) => ({ src, alt: images[index].name.replace(/\.[^.]+$/, '') })), point);
          this.host.notify(t("已通过 PicGo 上传并添加 {0} 张图片", paths.length)); return;
        }
      }
      if (!this.host.current().path && !(await this.host.save())) {
        if (uploadError) this.host.notify(t("{0} 已取消本地保存，图片未插入。", uploadError), true);
        return;
      }
      if (id !== this.host.documentId() || !this.editor.actions.isCurrent(point)) throw new Error(t("文稿已改变，请重新添加图片。"));
      const paths = await window.moye.saveAttachments({ documentPath: this.host.current().path!, images });
      if (id !== this.host.documentId() || !this.editor.actions.isCurrent(point)) throw new Error(t("文稿已改变，图片已保存在附件目录。"));
      this.editor.actions.images(paths.map((src, index) => ({ src, alt: images[index].name.replace(/\.[^.]+$/, '') })), point);
      this.host.notify(uploadError ? t("{0} 已改为本地附件，添加 {1} 张图片。", uploadError, paths.length) : t("已添加 {0} 张图片", paths.length), Boolean(uploadError));
    });
  }
  private async uploadForNode(file: File) {
    if (this.host.blocked()) return '';
    const point = this.editor.actions.capture(), id = this.host.documentId(); let result = '';
    await this.host.run(async () => {
      const images = await readFiles([file]);
      if (this.host.autoUpload()) {
        try {
          const [src] = await this.host.upload(images);
          if (id === this.host.documentId() && this.editor.actions.isCurrent(point)) result = src;
          return;
        } catch (error) { this.host.notify(t("{0} 将改为本地附件。", String(error)), true); }
      }
      if (!this.host.current().path && !(await this.host.save())) return;
      if (id !== this.host.documentId() || !this.editor.actions.isCurrent(point)) return;
      const [src] = await window.moye.saveAttachments({ documentPath: this.host.current().path!, images });
      if (id === this.host.documentId() && this.editor.actions.isCurrent(point)) result = src;
    });
    return result;
  }
}

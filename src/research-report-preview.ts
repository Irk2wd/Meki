import { ht, t } from '../electron/i18n.mjs';
import type { ResearchEvidenceFile, ResearchReference } from '../shared/research';
import { icon } from './icons';
import './research-report-preview.css';

type ReportFile = Pick<ResearchReference, 'id' | 'title' | 'relativePath'>;
interface ReportActions {
  read(id: string): Promise<ResearchEvidenceFile>;
  reveal(id: string): Promise<void>;
  viewBody?: () => Promise<void>;
  initialPage?: number;
  origin?: HTMLElement;
  notify(message: string, error?: boolean): void;
}
interface Pages { count: number; show(pageNumber: number): Promise<void> }
const message = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');

async function openPages(file: ResearchEvidenceFile, mount: HTMLElement, signal: AbortSignal): Promise<Pages> {
  if (file.kind === 'pdf' && file.bytes) {
    const { openPdfPreview } = await import('./research-report-pdf');
    signal.throwIfAborted();
    return openPdfPreview(mount, file.bytes, signal);
  }
  if (file.kind === 'pptx' && file.bytes) {
    const { openPptxPreview } = await import('./research-report-pptx');
    signal.throwIfAborted();
    return openPptxPreview(mount, file.bytes, signal);
  }
  throw new Error(t("无法预览此文件，可定位原文件查看。"));
}

export class ResearchReportPreview {
  private dialog = document.createElement('dialog');
  private onClose?: () => void;

  constructor() {
    this.dialog.id = 'research-report-dialog';
    this.dialog.setAttribute('aria-labelledby', 'research-report-title');
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.clear();
    });
    document.body.append(this.dialog);
  }

  private clear() {
    this.onClose?.();
    this.onClose = undefined;
    this.dialog.onkeydown = null;
    this.dialog.replaceChildren();
  }

  show(files: ReportFile[], actions: ReportActions) {
    const dialog = this.dialog;
    if (dialog.open || !files.length) return;
    this.clear();
    dialog.innerHTML = `<header class="dialog-heading"><div>
        <h2 id="research-report-title"></h2><p id="research-report-path"></p></div>
        <button type="button" class="icon-button" data-report-close aria-label="${ht("关闭汇报预览")}" autofocus>${icon('close', 16)}</button>
      </header>
      <div class="research-report-tools">
        <select id="research-report-file" aria-label="${ht("选择汇报文件")}"${files.length < 2 ? ' hidden' : ''}></select>
        <button type="button" class="secondary-button" data-report-body${!actions.viewBody ? ' hidden' : ''}>${ht("查看事件正文")}</button>
        <button type="button" class="secondary-button" data-report-reveal>${ht("定位原文件")}</button>
      </div>
      <div class="research-report-stage" aria-busy="true"><div class="research-report-mount"></div>
        <p id="research-report-status" role="status"></p></div>
      <footer class="research-report-pager" tabindex="-1">
        <button type="button" class="secondary-button" data-report-prev disabled>${icon('back', 14)} ${ht("上一页")}</button>
        <output id="research-report-page" aria-live="polite"></output>
        <button type="button" class="secondary-button" data-report-next disabled>${ht("下一页")} ${icon('chevron', 14)}</button>
      </footer>`;
    const element = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
    const select = element<HTMLSelectElement>('#research-report-file');
    for (const file of files) select.add(new Option(file.title, file.id));
    const content = element('.research-report-mount');
    const stage = element('.research-report-stage');
    const status = element('#research-report-status');
    const counter = element('#research-report-page');
    const pager = element('.research-report-pager');
    const previous = element<HTMLButtonElement>('[data-report-prev]');
    const next = element<HTMLButtonElement>('[data-report-next]');
    let request: AbortController | undefined, pages: Pages | undefined, page = 1, painting = false;
    let leavingForBody = false;
    const isActive = (controller: AbortController) => dialog.open && request === controller && !controller.signal.aborted;
    const controls = () => {
      const previousDisabled = !pages || painting || page <= 1;
      const nextDisabled = !pages || painting || page >= pages.count;
      const focus = document.activeElement;
      if ((focus === previous && previousDisabled) || (focus === next && nextDisabled)) pager.focus({ preventScroll: true });
      previous.disabled = previousDisabled;
      next.disabled = nextDisabled;
      counter.textContent = pages ? t("第 {0} 页，共 {1} 页", page, pages.count) : '';
      stage.setAttribute('aria-busy', String(painting));
    };
    async function render(pageNumber: number) {
      const controller = request;
      if (!pages || !controller || painting || pageNumber < 1 || pageNumber > pages.count) return;
      const mount = content.firstElementChild as HTMLElement;
      mount.hidden = false;
      painting = true;
      page = pageNumber;
      controls();
      status.hidden = false;
      status.textContent = t("正在渲染页面…");
      try {
        await pages.show(pageNumber);
        if (isActive(controller)) status.hidden = true;
      } catch (error) {
        if (isActive(controller)) { mount.hidden = true; status.textContent = message(error); }
      } finally {
        if (isActive(controller)) { painting = false; controls(); }
      }
    }
    async function load(initialPage = 1) {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      pages = undefined;
      page = 1;
      painting = true;
      controls();
      const file = files[select.selectedIndex];
      element('#research-report-title').textContent = file.title;
      const pathLabel = element('#research-report-path');
      pathLabel.textContent = file.relativePath;
      pathLabel.hidden = file.relativePath === file.title;
      const mount = document.createElement('div');
      mount.className = 'research-report-document';
      mount.inert = true;
      content.replaceChildren(mount);
      status.hidden = false;
      status.textContent = t("正在读取汇报…");
      try {
        const input = await actions.read(file.id);
        if (!isActive(controller)) return;
        const loaded = await openPages(input, mount, controller.signal);
        if (!isActive(controller)) return;
        if (!loaded.count) throw new Error(t("此文件没有可预览的页面。"));
        pages = loaded;
        painting = false;
        await render(Math.min(Math.max(1, initialPage), loaded.count));
        if (initialPage > loaded.count && isActive(controller)) actions.notify(t("报告页数已变化，已打开最后一页。"));
      } catch (error) {
        if (!isActive(controller)) return;
        controller.abort();
        painting = false;
        controls();
        status.textContent = message(error);
      }
    }

    select.addEventListener('change', () => { void load(); });
    previous.addEventListener('click', () => { void render(page - 1); });
    next.addEventListener('click', () => { void render(page + 1); });
    dialog.onkeydown = event => {
      if (event.target === select || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      void render(page + (event.key === 'ArrowLeft' ? -1 : 1));
    };
    element('[data-report-close]').addEventListener('click', () => dialog.close());
    element('[data-report-reveal]').addEventListener('click', () => {
      void actions.reveal(select.value).catch(error => { status.hidden = false; status.textContent = message(error); });
    });
    element('[data-report-body]').addEventListener('click', () => {
      leavingForBody = true;
      dialog.close();
      void actions.viewBody?.().catch(error => actions.notify(message(error), true));
    });
    this.onClose = () => {
      request?.abort();
      if (!leavingForBody && actions.origin?.isConnected) actions.origin.focus({ preventScroll: true });
    };
    dialog.showModal();
    void load(actions.initialPage);
  }
}

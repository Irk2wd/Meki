import { ht, t } from '../electron/i18n.mjs';
import type { ExportKind, ExportOptions, ExportPresetCatalog } from '../shared/export';
import './export-dialog.css';

export class ExportDialog {
  private dialog = document.createElement('dialog');
  private catalog: ExportPresetCatalog = { presets: [], templates: [] };
  private working = false;
  private request = 0;
  constructor(private submit: (options: ExportOptions) => Promise<void>) {
    this.dialog.id = 'export-dialog';
    this.dialog.innerHTML = `<form method="dialog"><div class="dialog-heading"><h2>${ht("导出文稿")}</h2><button value="cancel" class="icon-button" aria-label="${ht("关闭导出设置")}">×</button></div>
      <fieldset class="export-presets"><legend>${ht("导出预设")}</legend><label>${ht("预设")}<select id="export-preset"><option value="">${ht("当前设置")}</option></select></label><label>${ht("名称")}<input id="export-preset-name" maxlength="60" placeholder="${ht("例如：A4 报告")}"></label><div class="export-buttons"><button type="button" id="save-export-preset">${ht("保存预设")}</button><button type="button" id="save-as-export-preset">${ht("另存预设")}</button><button type="button" id="delete-export-preset">${ht("删除预设")}</button></div></fieldset>
      <label>${ht("格式")}<select id="export-kind"><option value="pdf">${ht("PDF 文档")}</option><option value="png">${ht("PNG 文稿长图")}</option><option value="html">${ht("HTML · 保留排版")}</option><option value="plain-html">${ht("HTML · 正文无样式")}</option><option value="docx">Word DOCX</option><option value="epub">${ht("EPUB 电子书")}</option></select></label>
      <div id="pdf-options" class="export-fields"><label>${ht("纸张")}<select id="pdf-paper"><option>A4</option><option>Letter</option><option>A5</option></select></label><label>${ht("方向")}<select id="pdf-orientation"><option value="portrait">${ht("纵向")}</option><option value="landscape">${ht("横向")}</option></select></label><label>${ht("四边页边距（毫米）")}<input id="pdf-margin" type="number" min="5" max="40" value="19"></label><label><input id="pdf-pages" type="checkbox"> ${ht("显示页码")}</label><label><input id="pdf-header" type="checkbox"> ${ht("页眉显示文稿标题")}</label><label><input id="pdf-heading-break" type="checkbox"> ${ht("从第二个一级标题起另起一页")}</label></div>
      <div id="png-options" class="export-fields" hidden><label>${ht("排版宽度（px）")}<input id="png-width" type="number" min="640" max="1600" step="1" value="960"></label><label>${ht("清晰度")}<select id="png-scale"><option value="2">${ht("2 倍")}</option><option value="1">${ht("1 倍")}</option></select></label><p>${ht("单张最多 20,000 px 高、4,000 万像素。过长文稿请使用 PDF。")}</p></div>
      <div id="export-appearance"><label>${ht("导出主题")}<select id="export-theme"><option value="current">${ht("沿用编辑器")}</option><option value="paper">${ht("纸白")}</option><option value="linen">${ht("亚麻")}</option><option value="night">${ht("夜墨")}</option></select></label><label>${ht("导出字号")}<input id="export-font-size" type="number" min="12" max="32" placeholder="${ht("沿用编辑器")}"></label><p>${ht("默认沿用预览的主题、字体和正文排版，PDF 按纸张分页。需要白底时可选择纸白；这里的设置只影响导出。")}</p></div>
      <div id="pandoc-options" hidden><p>${ht("Word 中常见公式可继续编辑；复杂公式或转换失败时保留高清图片，并在完成后提示数量。EPUB 的公式与所有图表使用图片。远程图片需先保存到文稿目录。")}</p><p id="pandoc-status" role="status"></p><button type="button" id="choose-pandoc">${ht("选择本机 Pandoc…")}</button></div>
      <div id="word-template-options" hidden><label>${ht("Word 样式模板")}<select id="word-reference"><option value="">${ht("不使用模板")}</option></select></label><div class="export-buttons"><button type="button" id="choose-word-reference">${ht("选择模板…")}</button><button type="button" id="delete-word-reference">${ht("删除模板副本")}</button></div><p>${ht("使用所选 DOCX 的样式、页眉页脚及页面设置，忽略模板正文；应用保存独立副本。")}</p></div>
      <p id="plain-note" hidden>${ht("移除正文 CSS；公式和图表以内嵌高清图片保留。所有图片必须可以离线读取。")}</p>
      <p id="export-feedback" role="status"></p><div class="dialog-actions"><span>${ht("按点击导出时的内容生成，后续输入会保留。")}</span><button class="primary-button" type="button" id="confirm-export">${ht("导出…")}</button></div></form>`;
    document.body.append(this.dialog);
    this.field('export-kind').addEventListener('change', () => { void this.update(); });
    this.field('export-preset').addEventListener('change', () => {
      const preset = this.catalog.presets.find(item => item.id === this.field('export-preset').value);
      this.field('export-preset-name').value = preset?.name || '';
      if (preset) this.apply(preset.options); void this.update();
    });
    this.on('choose-pandoc', async () => { const status = await window.moye.choosePandoc(); this.field('#pandoc-status').textContent = status.message; });
    this.on('save-export-preset', () => this.savePreset(false));
    this.on('save-as-export-preset', () => this.savePreset(true));
    this.on('delete-export-preset', async () => {
      const id = this.field('export-preset').value; if (!id) throw new Error(t("请先选择要删除的预设。"));
      await window.moye.deleteExportPreset(id); await this.refresh(); this.field('export-preset-name').value = ''; this.feedback(t("已删除预设，当前导出设置保留。"));
    });
    this.on('choose-word-reference', async () => {
      const template = await window.moye.chooseExportReference(); if (!template) return;
      await this.refresh(); this.field('word-reference').value = template.id; this.feedback(t("已保存模板副本。"));
    });
    this.on('delete-word-reference', async () => {
      const id = this.field('word-reference').value; if (!id) throw new Error(t("请先选择要删除的模板。"));
      await window.moye.deleteExportReference(id); await this.refresh(); this.feedback(t("已删除应用内模板副本，原文件保持不变。"));
    });
    this.on('confirm-export', async () => {
      const options = this.options();
      if (options.kind === 'docx' || options.kind === 'epub') { const status = await window.moye.exportTools(); if (!status.available) throw new Error(status.message); }
      if (!this.dialog.open) return;
      this.dialog.close(); await this.submit(options);
    });
  }
  private field(id: string) { return this.dialog.querySelector<HTMLInputElement | HTMLSelectElement>(id.startsWith('#') ? id : `#${id}`)!; }
  private checked(id: string) { return (this.field(id) as HTMLInputElement).checked; }
  private on(id: string, action: () => Promise<void>) {
    this.field(id).addEventListener('click', () => {
      if (this.working) return; this.working = true;
      this.dialog.querySelectorAll<HTMLButtonElement>('button[type="button"]').forEach(button => { button.disabled = true; });
      void action().catch(error => this.feedback(String(error))).finally(() => {
        this.working = false; this.dialog.querySelectorAll<HTMLButtonElement>('button[type="button"]').forEach(button => { button.disabled = false; });
      });
    });
  }
  private options(): ExportOptions {
    const kind = this.field('export-kind').value as ExportKind;
    const margin = Number(this.field('pdf-margin').value), pngWidth = Number(this.field('png-width').value), pngScale = Number(this.field('png-scale').value);
    const pdf = { pageSize: this.field('pdf-paper').value as 'A4' | 'Letter' | 'A5', landscape: this.field('pdf-orientation').value === 'landscape', margin, pageNumbers: this.checked('pdf-pages'), header: this.checked('pdf-header'), pageBreakBeforeH1: this.checked('pdf-heading-break') };
    if (kind === 'pdf' && (!Number.isFinite(margin) || margin < 5 || margin > 40 || (pdf.pageNumbers || pdf.header) && margin < 12)) throw new Error(t("页边距需为 5–40 毫米；页眉或页码需要至少 12 毫米。"));
    if (kind === 'png' && (!Number.isInteger(pngWidth) || pngWidth < 640 || pngWidth > 1600)) throw new Error(t("图片宽度需为 640–1600 px。"));
    const styled = ['pdf', 'png', 'html'].includes(kind), fontSize = this.field('export-font-size').value ? Number(this.field('export-font-size').value) : null;
    if (styled && fontSize !== null && (!Number.isFinite(fontSize) || fontSize < 12 || fontSize > 32)) throw new Error(t("导出字号需为 12–32 px，留空沿用编辑器。"));
    return { kind, ...(kind === 'pdf' ? { pdf } : {}), ...(kind === 'png' ? { pngWidth, pngScale } : {}), theme: styled ? this.field('export-theme').value as ExportOptions['theme'] : 'current', fontSize: styled ? fontSize : null, referenceId: kind === 'docx' ? this.field('word-reference').value || null : null };
  }
  private apply(options: ExportOptions) {
    this.field('export-kind').value = options.kind;
    const pdf = options.pdf;
    if (pdf) {
      this.field('pdf-paper').value = pdf.pageSize; this.field('pdf-orientation').value = pdf.landscape ? 'landscape' : 'portrait'; this.field('pdf-margin').value = String(pdf.margin);
      for (const [id, checked] of [['pdf-pages', pdf.pageNumbers], ['pdf-header', pdf.header], ['pdf-heading-break', pdf.pageBreakBeforeH1 || false]] as const) (this.field(id) as HTMLInputElement).checked = checked;
    }
    this.field('png-width').value = String(options.pngWidth ?? 960); this.field('png-scale').value = String(options.pngScale ?? 2);
    this.field('export-theme').value = options.theme || 'current'; this.field('export-font-size').value = options.fontSize ? String(options.fontSize) : '';
    this.field('word-reference').value = options.referenceId || '';
  }
  private async savePreset(asNew: boolean) {
    const id = asNew ? undefined : this.field('export-preset').value || undefined;
    const preset = await window.moye.saveExportPreset({ id, name: this.field('export-preset-name').value, options: this.options() });
    await this.refresh(); this.field('export-preset').value = preset.id; this.feedback(t("已保存导出预设。"));
  }
  private async refresh() {
    this.catalog = await window.moye.listExportPresets();
    for (const [id, empty, items] of [['export-preset', t("当前设置"), this.catalog.presets], ['word-reference', t("不使用模板"), this.catalog.templates]] as const) {
      const select = this.field(id) as HTMLSelectElement, previous = select.value;
      select.replaceChildren(new Option(empty, ''));
      for (const item of items) select.add(new Option(item.name, item.id));
      select.value = items.some(item => item.id === previous) ? previous : '';
    }
  }
  private feedback(message: string) { this.field('export-feedback').textContent = message.replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, ''); }
  private async update() {
    const request = ++this.request, kind = this.field('export-kind').value;
    for (const [id, show] of [['pdf-options', kind === 'pdf'], ['png-options', kind === 'png'], ['export-appearance', ['pdf','png','html'].includes(kind)], ['pandoc-options', kind === 'docx' || kind === 'epub'], ['word-template-options', kind === 'docx'], ['plain-note', kind === 'plain-html']] as const) this.field(id).hidden = !show;
    this.feedback('');
    if (kind === 'docx' || kind === 'epub') {
      try { const status = await window.moye.exportTools(); if (request === this.request) this.field('pandoc-status').textContent = status.message; }
      catch (error) { if (request === this.request) this.feedback(String(error)); }
    }
  }
  open(kind?: ExportKind) {
    if (kind) this.field('export-kind').value = kind;
    void this.update(); this.dialog.showModal();
    void this.refresh().catch(error => this.feedback(String(error)));
  }
}

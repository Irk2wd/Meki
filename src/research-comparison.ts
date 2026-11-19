import DOMPurify from 'dompurify';
import { ht, t } from '../electron/i18n.mjs';
import { comparisonLimits, evidenceImageMime } from '../electron/research-comparison.mjs';
import type { ResearchComparison, ResearchDocument, ResearchEvidenceFile, ResearchReference, ResearchWidth } from '../shared/research';
import { icon } from './icons';
import { renderMarkdown } from './markdown-render';
import { escapeResearch as escape, researchOption as option } from './research-tools';
import './research-comparison.css';

const columnLabel = (index: number) => t("第 {0} 列", index + 1);
const rowLabel = (index: number) => t("第 {0} 行", index + 1);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class ComparisonGridEditor {
  private grid = document.createElement('div');
  private controls = document.createElement('div');

  constructor(host: HTMLElement, documents: ResearchReference[], comparison?: ResearchComparison) {
    this.grid.className = 'research-comparison-editor-grid';
    this.controls.className = 'research-actions';
    const images = documents.filter(file => file.sourceId && evidenceImageMime(file.relativePath));
    host.innerHTML = `<datalist id="research-comparison-images">${images.map(file =>
      option(file.id, `${file.title} · ${file.relativePath}`, '')).join('')}</datalist>`;
    if (!images.length) host.insertAdjacentHTML('beforeend', `<p class="research-empty-list">${ht("在「资料」中登记原图证据后，可在这里选择。")}</p>`);
    host.append(this.grid, this.controls);
    this.draw(comparison ?? { columns: [columnLabel(0), columnLabel(1)], rows: [0, 1].map(index => ({ label: rowLabel(index), images: [null, null] })) });
    host.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-grid-action]');
      if (!button) return;
      const grid = this.value();
      const index = Number(button.dataset.index);
      switch (button.dataset.gridAction) {
        case 'add-row': grid.rows.push({ label: rowLabel(grid.rows.length), images: grid.columns.map(() => null) }); break;
        case 'add-column': grid.columns.push(columnLabel(grid.columns.length)); grid.rows.forEach(row => row.images.push(null)); break;
        case 'remove-row': grid.rows.splice(index, 1); break;
        case 'remove-column': grid.columns.splice(index, 1); grid.rows.forEach(row => row.images.splice(index, 1)); break;
      }
      this.draw(grid);
    });
  }

  value(): ResearchComparison {
    const columns = [...this.grid.querySelectorAll<HTMLInputElement>('[data-grid-column]')].map(input => input.value.trim());
    const rows = [...this.grid.querySelectorAll('tbody tr')].map(row => ({
      label: row.querySelector<HTMLInputElement>('[data-grid-row]')!.value.trim(),
      images: [...row.querySelectorAll<HTMLInputElement>('[data-grid-image]')].map(input => input.value.trim() || null),
    }));
    return { columns, rows };
  }

  private draw({ columns, rows }: ResearchComparison) {
    const remove = (axis: 'row' | 'column', index: number, length: number) => length > 1
      ? `<button type="button" class="icon-button" data-grid-action="remove-${axis}" data-index="${index}" aria-label="${ht("移除 {0}", axis === 'row' ? rowLabel(index) : columnLabel(index))}">${icon('close', 13)}</button>` : '';
    this.grid.innerHTML = `<table><thead><tr><th>${ht("行与列")}</th>${columns.map((label, index) => `<th><div class="research-comparison-axis-field">
      <input data-grid-column required maxlength="120" aria-label="${escape(columnLabel(index))}" value="${escape(label)}">${remove('column', index, columns.length)}</div></th>`).join('')}</tr></thead>
      <tbody>${rows.map(({ label, images }, row) => `<tr><th><div class="research-comparison-axis-field">
        <input data-grid-row required maxlength="120" aria-label="${escape(rowLabel(row))}" value="${escape(label)}">${remove('row', row, rows.length)}</div></th>
        ${images.map((image, column) => `<td><input data-grid-image maxlength="64" list="research-comparison-images"
          aria-label="${ht("第 {0} 行第 {1} 列原图", row + 1, column + 1)}" placeholder="${ht("证据 ID")}" value="${escape(image ?? '')}"></td>`).join('')}</tr>`).join('')}</tbody></table>`;
    this.controls.innerHTML = `<button type="button" class="secondary-button" data-grid-action="add-row"${rows.length >= comparisonLimits.rows ? ' disabled' : ''}>${ht("添加行")}</button>
      <button type="button" class="secondary-button" data-grid-action="add-column"${columns.length >= comparisonLimits.columns ? ' disabled' : ''}>${ht("添加列")}</button>`;
  }
}

type ZoomMode = 'fit' | 'pixels';
interface ImageRow { mode: ZoomMode; zoom: number; x: number; y: number; tiles: ImageTile[] }
interface ImageTile { viewport: HTMLElement; row: ImageRow; evidence: string; image?: HTMLImageElement }

export class ComparisonViewer {
  private dialog = document.createElement('dialog');
  private tiles = new Map<HTMLElement, ImageTile>();
  private rows: ImageRow[] = [];
  private visibility?: IntersectionObserver;
  private drag?: { tile: ImageTile; pointer: number; x: number; y: number };
  private resize = new ResizeObserver(entries => entries.forEach(({ target }) => {
    const tile = this.tiles.get(target as HTMLElement);
    if (tile) this.paint(tile);
  }));

  constructor() {
    this.dialog.id = 'research-comparison-dialog';
    this.dialog.setAttribute('aria-labelledby', 'research-comparison-title');
    document.body.append(this.dialog);
    window.addEventListener('resize', () => this.tiles.forEach(tile => this.paint(tile)));
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.clear(); });
    this.dialog.addEventListener('wheel', event => {
      const tile = this.tileAt(event.target);
      if (!tile?.image) return;
      event.preventDefault();
      const rect = tile.viewport.getBoundingClientRect();
      this.zoom(tile, Math.exp(clamp(-event.deltaY / 450, -1, 1)), event.clientX - rect.left - rect.width / 2,
        event.clientY - rect.top - rect.height / 2);
    }, { passive: false });
    this.dialog.addEventListener('pointerdown', event => {
      const tile = this.tileAt(event.target);
      if (!tile?.image || event.button !== 0 || this.drag) return;
      this.drag = { tile, pointer: event.pointerId, x: event.clientX, y: event.clientY };
      tile.viewport.setPointerCapture(event.pointerId);
    });
    this.dialog.addEventListener('pointermove', event => {
      const drag = this.drag;
      if (!drag || drag.pointer !== event.pointerId) return;
      this.pan(drag.tile, event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX;
      drag.y = event.clientY;
    });
    this.dialog.addEventListener('lostpointercapture', event => {
      if (this.drag?.pointer === event.pointerId) this.drag = undefined;
    });
    this.dialog.addEventListener('keydown', event => {
      const tile = this.tileAt(event.target);
      if (!tile?.image) return;
      switch (event.key) {
        case '+': case '=': this.zoom(tile, 1.25); break;
        case '-': this.zoom(tile, 0.8); break;
        case 'ArrowLeft': this.pan(tile, 32, 0); break;
        case 'ArrowRight': this.pan(tile, -32, 0); break;
        case 'ArrowUp': this.pan(tile, 0, 32); break;
        case 'ArrowDown': this.pan(tile, 0, -32); break;
        default: return;
      }
      event.preventDefault();
    });
  }

  show(root: string, { record, body }: ResearchDocument, actions: {
    width: ResearchWidth;
    back?(): void;
    evidence(id: string): Promise<void>;
    edit(): Promise<void>;
    error(error: unknown): void;
  }) {
    if (!record.comparison || this.dialog.open) return;
    this.clear();
    this.dialog.dataset.width = actions.width;
    const { columns, rows } = record.comparison;
    this.dialog.innerHTML = `<div class="dialog-heading"><div class="research-comparison-heading">
      ${actions.back ? `<button type="button" class="icon-button" data-comparison-back aria-label="${ht("返回事件列表")}" title="${ht("返回事件列表")}">${icon('back', 17)}</button>` : ''}
      <div><h2 id="research-comparison-title">${escape(record.title)}</h2><time>${escape(record.date)}</time></div></div>
      <button type="button" class="icon-button" data-comparison-close aria-label="${ht("关闭可视化展示")}">${icon('close', 16)}</button></div>
      <div class="research-comparison-toolbar"><div class="research-actions" role="group" aria-label="${ht("缩放")}">
        <button type="button" class="secondary-button" data-comparison-mode="fit">${ht("适应视口")}</button>
        <button type="button" class="secondary-button" data-comparison-mode="pixels">${ht("1:1 原像素")}</button></div>
        <small>${ht("滚轮缩放，拖动平移。同一行同步。")}</small>
        <button type="button" class="secondary-button" data-comparison-edit>${ht("编辑图注")}</button></div>
      <div class="research-comparison-scroll"><table style="--comparison-columns:${columns.length}"><thead><tr><td></td>${columns.map(label => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(({ label, images }) => `<tr><th scope="row">${escape(label)}</th>${images.map((image, column) =>
          `<td><div class="research-comparison-image"${image ? ` data-image-evidence="${escape(image)}" tabindex="0" aria-label="${escape(`${label} · ${columns[column]}`)}"` : ''}>
            <span>${image ? ht("正在读取原图…") : ht("未选择原图")}</span></div>${image ? `<button type="button" class="text-button" data-comparison-source="${escape(image)}">${ht("打开原图")}</button>` : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${body.trim() ? `<section class="research-comparison-caption"><h3>${ht("图注")}</h3><div></div></section>` : ''}`;
    const caption = this.dialog.querySelector('.research-comparison-caption > div');
    if (caption) caption.innerHTML = DOMPurify.sanitize(renderMarkdown(body).html);
    this.dialog.querySelector('[data-comparison-close]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('[data-comparison-back]')?.addEventListener('click', () => {
      this.dialog.close();
      actions.back?.();
    });
    this.dialog.querySelector('[data-comparison-edit]')!.addEventListener('click', () => { this.dialog.close(); void actions.edit().catch(actions.error); });
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-comparison-mode]')) {
      button.addEventListener('click', () => this.reset(button.dataset.comparisonMode as ZoomMode));
    }
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-comparison-source]')) {
      button.addEventListener('click', () => { void actions.evidence(button.dataset.comparisonSource!).catch(actions.error); });
    }
    this.dialog.showModal();
    const loads = new Map<string, Promise<ResearchEvidenceFile>>();
    this.visibility = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const tile = this.tiles.get(entry.target as HTMLElement);
        if (!entry.isIntersecting || !tile) continue;
        this.visibility?.unobserve(tile.viewport);
        if (!loads.has(tile.evidence)) loads.set(tile.evidence, window.meki.openResearchEvidence(root, tile.evidence));
        void this.load(tile, loads.get(tile.evidence)!);
      }
    }, { root: this.dialog.querySelector('.research-comparison-scroll') });
    this.rows = [...this.dialog.querySelectorAll('.research-comparison-scroll tbody tr')].map(element => {
      const row: ImageRow = { mode: 'fit', zoom: 1, x: 0.5, y: 0.5, tiles: [] };
      for (const viewport of element.querySelectorAll<HTMLElement>('[data-image-evidence]')) {
        const tile = { viewport, row, evidence: viewport.dataset.imageEvidence! };
        row.tiles.push(tile);
        this.tiles.set(viewport, tile);
        this.resize.observe(viewport);
        this.visibility!.observe(viewport);
      }
      return row;
    });
    this.updateMode();
  }

  private clear() {
    this.visibility?.disconnect();
    this.resize.disconnect();
    this.tiles.clear();
    this.rows = [];
    this.drag = undefined;
    this.dialog.replaceChildren();
  }

  private async load(tile: ImageTile, pending: Promise<ResearchEvidenceFile>) {
    try {
      const source = await pending;
      if (source.kind !== 'image') throw new Error(t("原图暂无法预览。"));
      const image = new Image();
      image.src = `data:${source.mime};base64,${source.content}`;
      image.alt = source.title;
      image.draggable = false;
      await image.decode();
      if (this.tiles.get(tile.viewport) !== tile) return;
      tile.image = image;
      tile.viewport.replaceChildren(image);
      this.paint(tile);
    } catch {
      if (this.tiles.get(tile.viewport) === tile) tile.viewport.textContent = t("原图暂无法预览。");
    }
  }

  private tileAt(target: EventTarget | null) {
    const element = (target as Element | null)?.closest<HTMLElement>('[data-image-evidence]');
    return element ? this.tiles.get(element) : undefined;
  }

  private scale({ image, viewport, row }: ImageTile) {
    const base = row.mode === 'pixels' ? 1 / window.devicePixelRatio
      : Math.min(viewport.clientWidth / image!.naturalWidth, viewport.clientHeight / image!.naturalHeight);
    return base * row.zoom;
  }

  private paint(tile: ImageTile) {
    const { image, row, viewport } = tile;
    if (!image || !viewport.clientWidth || !viewport.clientHeight) return;
    const scale = this.scale(tile), ratio = window.devicePixelRatio;
    const exact = row.mode === 'pixels' && row.zoom === 1;
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    let x = viewport.clientWidth / 2 - width * row.x, y = viewport.clientHeight / 2 - height * row.y;
    if (exact) {
      const { left, top } = viewport.getBoundingClientRect();
      x = Math.round((left + x) * ratio) / ratio - left;
      y = Math.round((top + y) * ratio) / ratio - top;
    }
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.transform = `translate(${x}px, ${y}px)`;
    image.style.imageRendering = exact ? 'pixelated' : '';
  }

  private pan(tile: ImageTile, dx: number, dy: number) {
    const { row, image } = tile;
    const scale = this.scale(tile);
    row.x = clamp(row.x - dx / (scale * image!.naturalWidth), 0, 1);
    row.y = clamp(row.y - dy / (scale * image!.naturalHeight), 0, 1);
    row.tiles.forEach(item => this.paint(item));
  }

  private zoom(tile: ImageTile, factor: number, x = 0, y = 0) {
    const { row, image } = tile;
    const scale = this.scale(tile);
    const zoom = clamp(row.zoom * factor, 0.25, 32);
    const shift = 1 - row.zoom / zoom;
    row.x = clamp(row.x + x / (scale * image!.naturalWidth) * shift, 0, 1);
    row.y = clamp(row.y + y / (scale * image!.naturalHeight) * shift, 0, 1);
    row.zoom = zoom;
    row.tiles.forEach(item => this.paint(item));
    this.updateMode();
  }

  private reset(mode: ZoomMode) {
    for (const row of this.rows) {
      row.mode = mode;
      row.zoom = 1;
      if (mode === 'fit') row.x = row.y = 0.5;
      row.tiles.forEach(tile => this.paint(tile));
    }
    this.updateMode();
  }

  private updateMode() {
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-comparison-mode]')) {
      button.setAttribute('aria-pressed', String(this.rows.every(row => row.mode === button.dataset.comparisonMode && row.zoom === 1)));
    }
  }
}

import { ht } from '../electron/i18n.mjs';
import type { ResearchComparison, ResearchSnapshot } from '../shared/research';
import { sampleTable } from './research-evidence-table';
import { escapeResearch as escape } from './research-tools';

/** Use the same camera row for both thumbnails, even when a grid has empty cells. */
export function comparisonSample(comparison: ResearchComparison) {
  const row = comparison.rows.find(row => row.images.filter(Boolean).length >= 2)
    ?? comparison.rows.find(row => row.images.some(Boolean));
  if (!row) return '';
  const images = row.images.flatMap((id, column) => id ? [{ id, label: comparison.columns[column] }] : []).slice(0, 2);
  return `<div class="research-sample-pair" role="group" aria-label="${escape(row.label)}" style="--sample-columns:${images.length}">
    <span class="research-sample-view" aria-hidden="true">${escape(row.label)}</span>${images.map(({ id, label }) => `<figure>
    <div class="research-sample-image" data-research-sample="${escape(id)}" aria-hidden="true"></div>
    <figcaption>${escape(label)}</figcaption></figure>`).join('')}</div>`;
}

async function readSample(root: string, id: string) {
  const file = await window.meki.openResearchEvidence(root, id);
  if (file.kind === 'image' && file.content && file.mime) {
    const image = new Image();
    image.src = `data:${file.mime};base64,${file.content}`;
    await image.decode();
    const scale = Math.min(1, 560 / image.naturalWidth, 300 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return `<img src="${canvas.toDataURL()}" alt="">`;
  }
  if (file.kind === 'csv' || file.kind === 'tsv') {
    const [head, ...rows] = sampleTable(file.content || '', file.kind === 'csv' ? ',' : '\t');
    if (!head) return ht("文件中没有表格数据。");
    const cell = (value: string) => escape(value.length > 80 ? value.slice(0, 79) + '…' : value);
    return `<table aria-label="${ht("表格摘录")}" aria-description="${escape(file.title)}"><thead><tr>${head.map(value => `<th scope="col">${cell(value)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(value => `<td>${cell(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  return ht("暂无预览");
}

export class EvidenceSamples {
  private observer: IntersectionObserver;
  private snapshot?: ResearchSnapshot;
  private cache = new Map<string, Promise<string>>();
  private queue = new Set<HTMLElement>();
  private active = 0;

  constructor(private content: HTMLElement) {
    this.observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting) this.queue.add(target as HTMLElement);
        else this.queue.delete(target as HTMLElement);
      }
      this.loadVisible();
    }, { root: content, rootMargin: '90px' });
  }

  show(snapshot?: ResearchSnapshot, reload = false) {
    this.observer.disconnect();
    this.queue.clear();
    if (snapshot !== this.snapshot || reload) this.cache.clear();
    this.snapshot = snapshot;
    if (snapshot) this.content.querySelectorAll('[data-research-sample]').forEach(el => this.observer.observe(el));
  }

  private loadVisible() {
    const state = this.snapshot;
    if (!state) return;
    for (const target of this.queue) {
      if (this.active >= 2) break;
      this.queue.delete(target);
      this.observer.unobserve(target);
      if (!this.content.contains(target)) continue;
      const id = target.dataset.researchSample!;
      let sample = this.cache.get(id);
      if (!sample) {
        sample = readSample(state.root, id).catch(() => ht("暂无预览"));
        this.cache.set(id, sample);
        if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
      }
      this.active++;
      void sample.then(markup => {
        if (this.cache.get(id) === sample && this.content.contains(target)) target.innerHTML = markup;
      }).finally(() => { this.active--; this.loadVisible(); });
    }
  }
}

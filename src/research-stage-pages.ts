import { ht } from '../electron/i18n.mjs';
import type { ResearchEntry } from '../shared/research';
import { icon } from './icons';

type Category = 'entry' | 'summary' | 'comparison' | 'event';
type RecordList = { entries: ResearchEntry[]; heading: string; rows: (entries: ResearchEntry[]) => string };
const sizeOptions = ['10', '20', '50', 'all'];
const sizeKey = (category: Category) => `mekir.research.recordsPerPage.${category}`;

function savedSize(category: Category) {
  try {
    const value = localStorage.getItem(sizeKey(category));
    if (value && sizeOptions.includes(value)) return value;
  } catch { /* Display preferences are optional. */ }
  return '10';
}

function pageNumbers(page: number, count: number) {
  if (count === 1) return [1];
  const first = Math.max(2, Math.min(page - 1, count - 4));
  const last = Math.min(count - 1, Math.max(page + 1, 5));
  const numbers: (number | '…')[] = [1];
  if (first === 3) numbers.push(2);
  if (first > 3) numbers.push('…');
  for (let n = first; n <= last; n++) numbers.push(n);
  if (last === count - 2) numbers.push(count - 1);
  if (last < count - 2) numbers.push('…');
  numbers.push(count);
  return numbers;
}

export class StageRecordPages {
  private scope = '';
  private pages = new Map<string, number>();
  private sizes: Partial<Record<Category, string>> = {};
  private lists = new Map<Category, RecordList>();

  begin(scope: string) {
    this.scope = scope;
    this.lists.clear();
  }

  reset(category?: Category) {
    if (category) this.pages.delete(`${this.scope}/${category}`);
    else this.pages.clear();
  }

  list(category: Category, heading: string, entries: ResearchEntry[], rows: RecordList['rows']) {
    if (!entries.length) { this.reset(category); return ''; }
    const list = { entries, heading, rows };
    this.lists.set(category, list);
    return `<div data-stage-list="${category}">${this.contents(category, list)}</div>`;
  }

  change(control: HTMLSelectElement | HTMLButtonElement) {
    const host = control.closest<HTMLElement>('[data-stage-list]');
    if (!host) return;
    const category = host.dataset.stageList as Category;
    const list = this.lists.get(category);
    if (!list) return;
    if (control instanceof HTMLSelectElement) {
      if (!sizeOptions.includes(control.value)) return;
      this.sizes[category] = control.value;
      try { localStorage.setItem(sizeKey(category), control.value); } catch { /* Display preferences are optional. */ }
      this.reset(category);
    } else {
      const page = Number(control.value);
      if (!Number.isSafeInteger(page) || page < 1) return;
      this.pages.set(`${this.scope}/${category}`, page);
    }
    host.innerHTML = this.contents(category, list);
    const heading = document.getElementById(list.heading);
    const viewport = host.closest('.research-content');
    if (heading && viewport) {
      heading.setAttribute('aria-describedby', `${list.heading}-range`);
      heading.focus({ preventScroll: true });
      const top = heading.getBoundingClientRect().top;
      const bounds = viewport.getBoundingClientRect();
      if (top < bounds.top || top >= bounds.bottom) heading.scrollIntoView({ block: 'start' });
    }
    return category;
  }

  private contents(category: Category, { entries, heading, rows }: RecordList) {
    const size = this.sizes[category] ??= savedSize(category);
    const total = entries.length;
    const limit = size === 'all' ? total : Number(size);
    const count = Math.ceil(total / limit);
    const key = `${this.scope}/${category}`;
    const page = Math.min(this.pages.get(key) || 1, count);
    this.pages.set(key, page);
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, total);
    const button = (number: number, action: string, label: string, content: string, state: string) =>
      `<button type="button" data-research-record-page="${category}-${action}" value="${number}" aria-label="${label}"${state}>${content}</button>`;
    const links = `<div class="research-record-page-links">
      ${button(page - 1, 'prev', ht("上一页"), icon('back', 14), page === 1 ? ' disabled' : '')}
      ${pageNumbers(page, count).map(n => n === '…' ? '<span aria-hidden="true">…</span>' :
        button(n, String(n), ht("第 {0} 页", n), String(n), n === page ? ' aria-current="page"' : '')).join('')}
      ${button(page + 1, 'next', ht("下一页"), icon('chevron', 14), page === count ? ' disabled' : '')}</div>`;
    const range = count === 1 ? ht("共 {0} 条", total) : ht("第 {0}–{1} 条，共 {2} 条", start + 1, end, total);
    return `${rows(entries.slice(start, end))}<nav class="research-record-pages" aria-labelledby="${heading}">
      <span class="research-record-count" id="${heading}-range">${range}</span>
      ${links}<label>${ht("每页显示")} <select data-research-record-size="${category}">
        ${sizeOptions.map(value => `<option value="${value}"${value === size ? ' selected' : ''}>${value === 'all' ? ht("全部") : value}</option>`).join('')}
      </select></label></nav>`;
  }
}

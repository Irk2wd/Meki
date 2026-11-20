import { ht, t } from '../electron/i18n.mjs';

const pageSize = 50;
const columnPageSize = 32;
const numberCell = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i;

// Index logical records without retaining every cell of a large timing log.
function scanRows(text: string, delimiter: string, start: number,
  onRow: (next: number, width: number) => boolean,
  onField?: (column: number, start: number, end: number) => void) {
  let fieldStart = start, column = 0, quoted = false;
  for (let i = start; i <= text.length; i++) {
    const char = text[i];
    if (char === '"' && (quoted || i === fieldStart)) {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (i < text.length && (quoted || (char !== delimiter && char !== '\r' && char !== '\n'))) continue;
    if (i === text.length && i === fieldStart && column === 0) return;
    onField?.(column, fieldStart, i);
    column++;
    if (char !== delimiter) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (!onRow(i + 1, column)) return;
      column = 0;
    }
    fieldStart = i + 1;
  }
}

function indexTable(text: string, delimiter: string) {
  const offsets = [0];
  let height = 0, width = 0;
  scanRows(text, delimiter, 0, (next, columns) => {
    width = Math.max(columns, width);
    if (++height % pageSize === 0) offsets.push(next);
    return true;
  });

  function read(startRow: number, count: number, startColumn: number) {
    const block = Math.floor(startRow / pageSize);
    let row = block * pageSize, cells: string[] = [];
    const rows: string[][] = [];
    if (startRow >= height) return rows;
    scanRows(text, delimiter, offsets[block], () => {
      if (row++ >= startRow) { rows.push(cells); cells = []; }
      return rows.length < count;
    }, (column, start, end) => {
      if (row < startRow || column < startColumn || column >= startColumn + columnPageSize) return;
      const field = text.slice(start, end);
      cells.push(field.startsWith('"') && field.endsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field);
    });
    return rows;
  }
  return { height, width, read };
}

export function showEvidenceTable(body: HTMLElement, text: string, delimiter: string, title: string) {
  const model = indexTable(text, delimiter);
  if (!model.height) {
    const empty = document.createElement('p');
    empty.textContent = t("文件中没有表格数据。");
    body.append(empty);
    return;
  }
  body.classList.add('research-evidence-table');
  body.innerHTML = `<div class="research-table-tools">
      <output aria-live="polite"></output>
      <label><input type="checkbox" checked> ${ht("首行作为列名")}</label>
    </div><div class="research-table-scroll" tabindex="0" role="region"><table><thead></thead><tbody></tbody></table></div>
    <nav class="research-table-pages" hidden>
      <span data-row-pages><button type="button" class="secondary-button" data-prev>${ht("上一页")}</button>
        <output></output><button type="button" class="secondary-button" data-next>${ht("下一页")}</button></span>
      <span data-column-pages><button type="button" class="secondary-button" data-prev>${ht("上一组列")}</button>
        <output></output><button type="button" class="secondary-button" data-next>${ht("下一组列")}</button></span>
    </nav>`;
  const scroll = body.querySelector<HTMLElement>('.research-table-scroll')!;
  scroll.setAttribute('aria-label', title);
  const table = body.querySelector('table')!;
  table.setAttribute('aria-label', title);
  const heading = body.querySelector('input')!;
  const pager = body.querySelector('nav')!;
  let page = 0, columnPage = 0;

  function navigation(group: HTMLElement, current: number, total: number, label: string, change: (to: number) => void) {
    group.hidden = total <= 1;
    group.querySelector('output')!.textContent = label;
    for (const [selector, target] of [['[data-prev]', current - 1], ['[data-next]', current + 1]] as const) {
      const button = group.querySelector<HTMLButtonElement>(selector)!;
      button.disabled = target < 0 || target >= total;
      button.onclick = () => { change(target); render(); };
    }
  }

  function render() {
    const headerRows = Number(heading.checked), dataRows = model.height - headerRows;
    const pages = Math.ceil(dataRows / pageSize), columnPages = Math.ceil(model.width / columnPageSize);
    const first = columnPage * columnPageSize, last = Math.min(first + columnPageSize, model.width);
    const names = headerRows ? model.read(0, 1, first)[0] : [];
    const rows = model.read(headerRows + page * pageSize, pageSize, first);
    const head = document.createElement('tr');
    for (let col = first; col < last; col++) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = names[col - first] || t("列 {0}", col + 1);
      const values = rows.map(row => row[col - first]).filter(Boolean);
      if (values.length && values.every(value => numberCell.test(value))) th.className = 'number';
      head.append(th);
    }
    table.tHead!.replaceChildren(head);
    const fragment = document.createDocumentFragment();
    for (const values of rows) {
      const row = document.createElement('tr');
      for (let i = 0; i < last - first; i++) {
        const cell = row.insertCell();
        cell.textContent = values[i] ?? '';
        if (numberCell.test(cell.textContent)) cell.className = 'number';
      }
      fragment.append(row);
    }
    table.tBodies[0].replaceChildren(fragment);
    body.querySelector('output')!.textContent = t("{0} 行 × {1} 列", dataRows, model.width);
    pager.hidden = pages <= 1 && columnPages <= 1;
    navigation(pager.querySelector('[data-row-pages]')!, page, pages, t("第 {0} 页，共 {1} 页", page + 1, pages), to => { page = to; });
    navigation(pager.querySelector('[data-column-pages]')!, columnPage, columnPages, t("第 {0}–{1} 列", first + 1, last), to => { columnPage = to; });
    scroll.scrollTo(0, 0);
  }
  heading.onchange = () => { page = 0; render(); };
  render();
}

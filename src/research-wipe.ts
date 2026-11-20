import { ht, t } from '../electron/i18n.mjs';
import type { ResearchComparison, ResearchEvidenceFile } from '../shared/research';
import { icon } from './icons';
import './research-wipe.css';

interface WipeReport { title: string; comparison: ResearchComparison }
interface WipeActions {
  read(id: string): Promise<ResearchEvidenceFile>;
  open(id: string, origin: HTMLElement): Promise<void>;
  error(error: unknown): void;
}

const hasPair = (row: ResearchComparison['rows'][number]) => new Set(row.images.filter(Boolean)).size >= 2;
export const supportsWipe = (comparison?: ResearchComparison) => comparison?.rows.some(hasPair) ?? false;

export function evidenceWipe(reports: WipeReport[], actions: WipeActions) {
  const figure = document.createElement('figure');
  figure.className = 'research-wipe';
  figure.innerHTML = `<figcaption><strong></strong><select data-wipe-report aria-label="${ht("选择图像对比")}"></select>
    <select data-wipe-row aria-label="${ht("选择对比行")}"></select></figcaption>
    <div class="research-wipe-stage" aria-busy="true">
      <button type="button" class="research-wipe-image" data-wipe-side="right" hidden></button>
      <button type="button" class="research-wipe-image" data-wipe-side="left" hidden></button>
      <div class="research-wipe-divider" role="slider" tabindex="0" aria-label="${ht("图像对比分界线")}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" hidden>
        <span aria-hidden="true">${icon('back', 12)}${icon('chevron', 12)}</span></div>
      <span class="research-wipe-status" role="status"></span></div>
    <div class="research-wipe-labels"></div>`;
  const reportSelect = figure.querySelector<HTMLSelectElement>('[data-wipe-report]')!;
  const rowSelect = figure.querySelector<HTMLSelectElement>('[data-wipe-row]')!;
  const stage = figure.querySelector<HTMLElement>('.research-wipe-stage')!;
  const divider = stage.querySelector<HTMLElement>('[role="slider"]')!;
  const status = stage.querySelector<HTMLElement>('[role="status"]')!;
  const sides = ['left', 'right'].map(side => stage.querySelector<HTMLButtonElement>(`[data-wipe-side="${side}"]`)!);
  const labels = figure.querySelector<HTMLElement>('.research-wipe-labels')!;
  let columns = [0, 1], request = 0, split = 50;

  function setSplit(value: number) {
    split = Math.max(0, Math.min(100, value));
    stage.style.setProperty('--wipe-split', `${split}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(split)));
    divider.setAttribute('aria-valuetext', `${Math.round(split)}%`);
  }
  function move(event: PointerEvent) {
    const bounds = stage.getBoundingClientRect();
    if (bounds.width) setSplit((event.clientX - bounds.left) * 100 / bounds.width);
  }
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    divider.setPointerCapture(event.pointerId);
    divider.focus({ preventScroll: true });
    move(event);
  });
  divider.addEventListener('pointermove', event => { if (divider.hasPointerCapture(event.pointerId)) move(event); });
  divider.addEventListener('keydown', event => {
    const step = event.shiftKey ? 10 : 1;
    const positions: Record<string, number> = { ArrowLeft: split - step, ArrowRight: split + step, Home: 0, End: 100, PageDown: split - 10, PageUp: split + 10 };
    if (!Object.hasOwn(positions, event.key)) return;
    event.preventDefault();
    setSplit(positions[event.key]);
  });

  const grid = () => reports[reportSelect.selectedIndex].comparison;
  const row = () => grid().rows[Number(rowSelect.value)];
  async function loadPair() {
    const ticket = ++request;
    stage.setAttribute('aria-busy', 'true');
    status.textContent = t("正在读取原图…");
    divider.hidden = true;
    sides.forEach(side => { side.hidden = true; side.replaceChildren(); });
    const ids = columns.map(column => row().images[column]!);
    try {
      const images = await Promise.all(ids.map(async id => {
        const file = await actions.read(id);
        if (file.kind !== 'image') throw new Error(t("原图暂无法预览。"));
        const image = new Image();
        image.alt = file.title;
        image.draggable = false;
        image.src = `data:${file.mime};base64,${file.content}`;
        await image.decode();
        return image;
      }));
      if (ticket !== request) return;
      const ratios = images.map(image => image.naturalWidth / image.naturalHeight);
      if (Math.abs(ratios[0] / ratios[1] - 1) > 0.01) {
        status.textContent = t("两张原图的宽高比不同，请分别打开原图。");
        return;
      }
      stage.style.setProperty('--wipe-aspect', String(ratios[0]));
      sides.forEach((side, i) => {
        side.setAttribute('aria-label', t("打开原图 · {0}", images[i].alt));
        side.title = side.getAttribute('aria-label')!;
        side.replaceChildren(images[i]);
        side.hidden = false;
      });
      divider.hidden = false;
      status.textContent = '';
    } catch {
      if (ticket === request) status.textContent = t("原图暂无法预览。");
    } finally {
      if (ticket === request) stage.setAttribute('aria-busy', 'false');
    }
  }
  function openSide(index: number, origin: HTMLElement) {
    void actions.open(row().images[columns[index]]!, origin).catch(actions.error);
  }
  sides.forEach((side, index) => side.addEventListener('click', () => openSide(index, side)));

  function renderLabels() {
    labels.replaceChildren();
    const available = row().images.flatMap((id, i) => id ? [i] : []);
    columns.forEach((column, side) => {
      const group = document.createElement('div');
      if (available.length > 2) {
        const select = document.createElement('select');
        select.setAttribute('aria-label', side ? t("右侧对比列") : t("左侧对比列"));
        for (const i of available) {
          const option = new Option(grid().columns[i], String(i));
          option.disabled = row().images[i] === row().images[columns[1 - side]];
          select.add(option);
        }
        select.value = String(column);
        select.onchange = () => {
          columns[side] = Number(select.value);
          renderLabels();
          labels.querySelectorAll('select')[side]?.focus({ preventScroll: true });
          void loadPair();
        };
        group.append(select);
      } else {
        const label = document.createElement('span');
        label.textContent = grid().columns[column];
        group.append(label);
      }
      const original = document.createElement('button');
      original.type = 'button';
      original.className = 'text-button';
      original.textContent = t("打开原图");
      original.setAttribute('aria-label', t("打开原图 · {0}", grid().columns[column]));
      original.onclick = () => openSide(side, original);
      group.append(original);
      labels.append(group);
    });
  }
  function selectRow() {
    const images = row().images;
    const left = images.findIndex(Boolean);
    columns = [left, images.findIndex(id => Boolean(id && id !== images[left]))];
    renderLabels();
    void loadPair();
  }
  function selectReport() {
    rowSelect.replaceChildren();
    grid().rows.forEach((item, index) => {
      if (hasPair(item)) rowSelect.add(new Option(item.label, String(index)));
    });
    selectRow();
  }
  reports.forEach((report, index) => reportSelect.add(new Option(report.title, String(index))));
  const title = figure.querySelector('strong')!;
  title.textContent = reports[0].title;
  title.hidden = reports.length > 1;
  reportSelect.hidden = reports.length === 1;
  reportSelect.onchange = selectReport;
  rowSelect.onchange = selectRow;
  setSplit(50);
  selectReport();
  return figure;
}

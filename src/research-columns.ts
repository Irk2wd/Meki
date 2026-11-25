import { t } from '../electron/i18n.mjs';

type Boundary = 'navigation' | 'list';
interface Widths { navigation?: number; preview?: number }
interface Range { min: number; max: number; value: number }
const minNavigation = 160, minList = 224, minPreview = 400;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const storageKey = (column: keyof Widths) => `mekir.research.columns.${column}`;

function savedWidth(column: keyof Widths) {
  try {
    const width = Number(localStorage.getItem(storageKey(column)));
    if (Number.isSafeInteger(width) && width > 0) return width;
  } catch { /* The layout also works without local storage. */ }
}

function columnLayout(width: number, navigationVisible: boolean, reading: boolean, preferred: Widths, stageNavigation: boolean) {
  const defaultNav = width <= 820 ? 180 : width <= 1020 ? 205 : 236;
  // A narrow workspace keeps the preview in an overlay.
  const fromStage = stageNavigation && navigationVisible;
  const split = reading && width > 760 && width - (navigationVisible ? minNavigation : 0) >= (fromStage ? minPreview : 730);
  const stageIndex = split && fromStage;
  const maxNav = Math.max(minNavigation, width - (stageIndex ? minPreview : split ? minList + minPreview : 300));
  const nav = navigationVisible ? clamp(preferred.navigation ?? defaultNav, minNavigation, maxNav) : 0;
  const main = width - nav;
  const defaultMain = width - (navigationVisible ? defaultNav : 0);
  const desiredPreview = preferred.preview ?? defaultMain - clamp(Math.round(defaultMain * .31), 242, 370);
  const preview = stageIndex ? main : split ? clamp(desiredPreview, minPreview, main - minList) : 0;
  return {
    split, stageIndex, preview, desiredPreview,
    navigation: { value: nav, min: minNavigation, max: split && !stageIndex ? width - preview - minList : maxNav },
    list: { value: main - preview, min: minList, max: main - minPreview },
  };
}

export class ResearchColumns {
  private shell: HTMLElement;
  private handles: Record<Boundary, HTMLElement>;
  private preferred: Widths = { navigation: savedWidth('navigation'), preview: savedWidth('preview') };
  private layout?: ReturnType<typeof columnLayout>;
  private drag?: { part: Boundary; pointer: number; x: number; start: number; before: Widths };

  constructor(private navigation: HTMLElement, private panel: HTMLElement, private host: HTMLElement) {
    this.shell = host.parentElement!;
    this.handles = {
      navigation: this.divider('navigation', t("调整项目导航宽度"), navigation),
      list: this.divider('list', t("调整记录列表与预览宽度"), panel),
    };
    window.addEventListener('blur', () => this.finish(false));
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.drag) return;
      event.preventDefault();
      event.stopPropagation();
      this.finish(false);
    }, true);
  }

  private divider(part: Boundary, label: string, pane: HTMLElement) {
    const handle = document.createElement('div');
    handle.hidden = true;
    handle.className = 'research-column-divider';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', label);
    handle.setAttribute('aria-controls', part === 'navigation' ? 'research-sidebar' : pane.id);
    handle.setAttribute('aria-orientation', 'vertical');
    handle.title = t("拖动调整宽度，双击或按 Enter 恢复默认");
    pane.after(handle);
    handle.addEventListener('blur', () => handle.removeAttribute('data-pointer-focus'));
    handle.addEventListener('pointerdown', event => {
      if (!this.layout || this.drag || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      // Chromium can retain :focus-visible when the pointer takes over a focused divider.
      handle.setAttribute('data-pointer-focus', '');
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      this.drag = { part, pointer: event.pointerId, x: event.clientX, start: this.layout[part].value, before: { ...this.preferred } };
      this.shell.classList.add('research-resizing');
      handle.setAttribute('data-resizing', '');
    });
    handle.addEventListener('pointermove', event => {
      if (this.drag?.pointer === event.pointerId) this.resize(part, this.drag.start + event.clientX - this.drag.x);
    });
    handle.addEventListener('pointerup', event => {
      if (this.drag?.pointer !== event.pointerId) return;
      this.resize(part, this.drag.start + event.clientX - this.drag.x);
      this.finish(true);
    });
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      handle.addEventListener(type, event => { if (this.drag?.pointer === event.pointerId) this.finish(false); });
    }
    handle.addEventListener('dblclick', () => this.reset(part));
    handle.addEventListener('keydown', event => {
      if (!this.layout || this.drag) return;
      handle.removeAttribute('data-pointer-focus');
      if (event.key === 'Enter') { event.preventDefault(); this.reset(part); return; }
      const { value, min, max } = this.layout[part];
      const step = event.shiftKey ? 48 : 12;
      const widths: Record<string, number> = { ArrowLeft: value - step, ArrowRight: value + step, Home: min, End: max };
      if (!Object.hasOwn(widths, event.key)) return;
      event.preventDefault();
      const before = { ...this.preferred };
      this.resize(part, widths[event.key]);
      this.saveChanges(before);
    });
    return handle;
  }

  update() {
    const active = this.shell.classList.contains('research-shell') && !this.panel.hidden;
    const reading = active && this.host.classList.contains('research-reader-open');
    const hasNav = this.navigation.getClientRects().length > 0 && !document.body.classList.contains('sidebar-hidden');
    // The fixed icon rail already sits outside the host. Only the full sidebar can be resized.
    const availableWidth = this.host.clientWidth + (hasNav ? this.navigation.offsetWidth : 0);
    const stageNavigation = this.host.classList.contains('research-stage-reading');
    const layout = columnLayout(availableWidth, hasNav, reading, this.preferred, stageNavigation);
    this.layout = layout;
    this.host.classList.toggle('research-peek-split', layout.split);
    this.host.classList.toggle('research-stage-index', layout.stageIndex);
    this.panel.inert = reading && (!layout.split || layout.stageIndex);
    this.handles.navigation.hidden = !active || !hasNav || (reading && !layout.split);
    this.handles.list.hidden = !layout.split || layout.stageIndex;
    if (this.drag && this.handles[this.drag.part].hidden) { this.finish(false); return; }
    if (!active) return;
    // Keep the expanded target current even when the window is resized with the rail folded.
    const expandedLayout = hasNav ? layout : columnLayout(availableWidth + this.navigation.offsetWidth, true, reading, this.preferred, stageNavigation);
    this.shell.style.setProperty('--research-navigation-width', `${expandedLayout.navigation.value}px`);
    this.host.style.setProperty('--research-list-width', `calc(100% - ${layout.preview}px)`);
    for (const part of ['navigation', 'list'] as const) {
      if (!this.handles[part].hidden) this.describe(this.handles[part], layout[part]);
    }
  }

  private describe(handle: HTMLElement, { min, max, value }: Range) {
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', t("{0} 像素", value));
  }

  private resize(part: Boundary, target: number) {
    const layout = this.layout!;
    const { min, max, value } = layout[part];
    const next = clamp(Math.round(target), min, max);
    if (next === value) return;
    if (part === 'navigation') {
      // Keep the far boundary still, including after the window previously squeezed the preview.
      if (layout.split && !layout.stageIndex && layout.desiredPreview > layout.preview) this.preferred.preview = layout.preview;
      this.preferred.navigation = next;
    } else this.preferred.preview = layout.preview + value - next;
    this.update();
  }

  private finish(commit: boolean) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    const handle = this.handles[drag.part];
    if (handle.hasPointerCapture(drag.pointer)) handle.releasePointerCapture(drag.pointer);
    handle.removeAttribute('data-resizing');
    this.shell.classList.remove('research-resizing');
    if (commit) this.saveChanges(drag.before);
    else { this.preferred = drag.before; this.update(); }
  }

  private reset(part: Boundary) {
    const before = { ...this.preferred };
    delete this.preferred[part === 'navigation' ? 'navigation' : 'preview'];
    this.update();
    this.saveChanges(before);
  }

  private saveChanges(before: Widths) {
    try {
      for (const column of ['navigation', 'preview'] as const) {
        const value = this.preferred[column];
        if (before[column] === value) continue;
        if (value === undefined) localStorage.removeItem(storageKey(column));
        else localStorage.setItem(storageKey(column), String(value));
      }
    } catch { /* Keep this window's widths when storage is unavailable. */ }
  }
}

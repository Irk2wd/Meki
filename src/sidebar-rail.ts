import { t } from '../electron/i18n.mjs';
import './sidebar-rail.css';

const foldDuration = 230;

function sidebarSize(width: number) {
  return { minWidth: `${width}px`, flexBasis: `${width}px` };
}

function measureSidebar(sidebar: HTMLElement, content: HTMLElement) {
  const positions = new Map<SVGSVGElement, { x: number; y: number; size: number; color: string }>();
  const origin = sidebar.getBoundingClientRect();
  for (const glyph of sidebar.querySelectorAll<SVGSVGElement>('button[aria-label] > svg[stroke="currentColor"]:first-child')) {
    const box = glyph.getBoundingClientRect();
    if (!box.width || box.bottom <= origin.top || box.top >= origin.bottom) continue;
    const size = glyph.viewBox.baseVal.width * glyph.getScreenCTM()!.a;
    positions.set(glyph, { x: box.left + box.width / 2 - origin.left, y: box.top + box.height / 2 - origin.top,
      size, color: getComputedStyle(glyph).color });
  }
  return { width: origin.width, contentWidth: content.getBoundingClientRect().width, glyphs: positions };
}

type SidebarLayout = ReturnType<typeof measureSidebar>;

function movingGlyphs(compact: SidebarLayout, expanded: SidebarLayout) {
  const layer = document.createElement('div');
  layer.className = 'sidebar-moving-glyphs';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  for (const [glyph, start] of compact.glyphs) {
    const end = expanded.glyphs.get(glyph);
    if (!end) continue;
    const copy = glyph.cloneNode(true) as SVGSVGElement;
    const style = copy.style;
    style.left = `${start.x}px`;
    style.top = `${start.y}px`;
    style.setProperty('--rail-size', `${start.size}px`);
    style.setProperty('--size-change', `${end.size - start.size}px`);
    style.setProperty('--travel-x', `${end.x - start.x}px`);
    style.setProperty('--travel-y', `${end.y - start.y}px`);
    style.setProperty('--rail-color', start.color);
    style.setProperty('--panel-color', end.color);
    layer.append(copy);
    glyph.setAttribute('data-fold-glyph', '');
  }
  return layer;
}

export class SidebarRail {
  private sidebar = document.querySelector<HTMLElement>('#app-sidebar')!;
  private content = this.sidebar.querySelector<HTMLElement>('.sidebar-content')!;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private motion?: { animation: Animation; glyphs: HTMLElement; expanded: boolean };
  private narrow = matchMedia('(max-width: 760px)');
  private desktopExpanded = true;
  private narrowExpanded = false;

  constructor(private saveDesktop: (expanded: boolean) => void) {
    const sidebar = this.sidebar;
    const pointerHints = () => sidebar.removeAttribute('data-keyboard-hints');
    document.addEventListener('pointermove', pointerHints, { passive: true });
    document.addEventListener('pointerdown', pointerHints, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Tab' || sidebar.contains(document.activeElement)) {
        sidebar.toggleAttribute('data-keyboard-hints', event.key !== 'Escape');
      }
    }, true);
    this.reducedMotion.addEventListener('change', () => this.stopMotion());
    window.addEventListener('resize', () => this.stopMotion());
    this.narrow.addEventListener('change', () => {
      this.narrowExpanded = false;
      this.apply(this.desktopExpanded);
    });
  }

  get expanded() {
    return this.narrow.matches ? this.narrowExpanded : this.desktopExpanded;
  }

  apply(desktopExpanded: boolean) {
    this.desktopExpanded = desktopExpanded;
    if (this.motion && this.motion.expanded !== this.expanded) this.stopMotion();
    document.body.classList.toggle('sidebar-hidden', !this.expanded);
    for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-action="sidebar"]')) {
      toggle.setAttribute('aria-expanded', String(this.expanded));
      toggle.setAttribute('aria-controls', 'app-sidebar');
      toggle.title = toggle.ariaLabel = this.expanded ? t("收起侧栏") : t("展开侧栏");
    }
  }

  toggle() {
    const expanded = !this.expanded;
    if (this.reducedMotion.matches || !this.sidebar.offsetWidth) {
      this.setExpanded(expanded);
      return;
    }
    if (this.motion) {
      this.motion.expanded = expanded;
      this.changeExpanded(expanded);
      this.motion.animation.reverse();
      return;
    }

    const before = measureSidebar(this.sidebar, this.content);
    this.changeExpanded(expanded);
    const after = measureSidebar(this.sidebar, this.content);
    if (!after.width || before.width === after.width) return;
    const [compact, full] = expanded ? [before, after] : [after, before];
    const rail = { '--sidebar-content-width': `${compact.contentWidth}px`, '--sidebar-layout': 'compact' };
    const panel = { '--sidebar-content-width': `${full.contentWidth}px`, '--sidebar-layout': 'expanded' };

    // The glyphs travel continuously while the two text layouts exchange at zero opacity.
    const glyphs = movingGlyphs(compact, full);
    this.sidebar.append(glyphs);
    this.sidebar.setAttribute('data-folding', '');
    const animation = this.sidebar.animate([
      { ...sidebarSize(compact.width), ...rail, '--sidebar-content-opacity': 1, '--sidebar-progress': 0 },
      { ...rail, '--sidebar-content-opacity': 0, offset: .44 },
      { ...panel, '--sidebar-content-opacity': 0, offset: .44 },
      { ...sidebarSize(full.width), ...panel, '--sidebar-content-opacity': 1, '--sidebar-progress': 1 },
    ], { duration: foldDuration, easing: 'cubic-bezier(.38, 0, .22, 1)', fill: 'both' });
    this.motion = { animation, glyphs, expanded };
    if (!expanded) {
      animation.currentTime = foldDuration;
      animation.reverse();
    }
    animation.onfinish = () => {
      if (this.motion?.animation === animation && animation.playState === 'finished') this.stopMotion();
    };
  }

  private stopMotion() {
    if (!this.motion) return;
    this.motion.animation.cancel();
    this.motion.glyphs.remove();
    for (const glyph of this.content.querySelectorAll('[data-fold-glyph]')) glyph.removeAttribute('data-fold-glyph');
    this.motion = undefined;
    this.sidebar.removeAttribute('data-folding');
  }

  setExpanded(expanded: boolean) {
    // Navigation commands reveal and focus their destination in the same event.
    this.stopMotion();
    this.changeExpanded(expanded);
  }

  private changeExpanded(expanded: boolean) {
    if (this.expanded === expanded) return;
    if (this.narrow.matches) {
      this.narrowExpanded = expanded;
      this.apply(this.desktopExpanded);
    } else this.saveDesktop(expanded);
  }
}

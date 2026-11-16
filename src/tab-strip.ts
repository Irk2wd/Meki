/** Scroll only the tab strip, keeping the name and its close button together. */
export function revealActiveTab(strip: HTMLElement): void {
  const tab = strip.querySelector<HTMLElement>('.document-tab.active');
  if (tab) revealTab(strip, tab);
}

function revealTab(strip: HTMLElement, tab: HTMLElement): void {
  if (!strip.clientWidth) return;
  const bounds = strip.getBoundingClientRect(), item = tab.getBoundingClientRect();
  if (item.left < bounds.left) strip.scrollLeft += item.left - bounds.left;
  else if (item.right > bounds.right) strip.scrollLeft += item.right - bounds.right;
}

export function configureTabStrip(strip: HTMLElement): void {
  strip.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey || event.deltaX || !event.deltaY || strip.scrollWidth <= strip.clientWidth) return;
    const before = strip.scrollLeft;
    strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1);
    if (strip.scrollLeft !== before) event.preventDefault();
  }, { passive: false });
  strip.addEventListener('focusin', event => {
    const tab = (event.target as Element).closest<HTMLElement>('.document-tab');
    if (tab) revealTab(strip, tab);
  });
}

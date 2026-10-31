import { t } from '../electron/i18n.mjs';
import { nodeViewCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { imageBlockView } from '@milkdown/kit/component/image-block';
import { closeHistory } from '@milkdown/kit/prose/history';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { imageDimension, imageSizeStyle, MAX_IMAGE_DIMENSION, safeImageSource } from './image-syntax';
import './editor-images.css';

/** Keep Crepe's image/upload/caption controls, and store sizing as real document attributes. */
function imageView(create: NodeViewConstructor): NodeViewConstructor {
  return (initial, view, getPos, decorations, innerDecorations) => {
    const base = create(initial, view, getPos, decorations, innerDecorations), dom = base.dom as HTMLElement;
    let node = initial, alive = true, resizing = false, cancelDrag: (() => void) | undefined;
    dom.classList.add('moye-image-block');
    const image = () => dom.querySelector<HTMLImageElement>('img');
    const editable = () => alive && view.editable && dom.isConnected && !dom.closest('[hidden],[inert]');
    const position = () => {
      const pos = getPos();
      return alive && typeof pos === 'number' && view.state.doc.nodeAt(pos)?.type === node.type ? pos : undefined;
    };
    const setSize = (width: number | null, height: number | null) => {
      const pos = position(); if (pos === undefined || !editable()) return;
      const current = view.state.doc.nodeAt(pos)!;
      if ((width || height) && !safeImageSource(current.attrs.src)) return;
      if (current.attrs.width === width && current.attrs.height === height) return;
      view.dispatch(closeHistory(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width, height, ratio: 1 })));
      view.dispatch(closeHistory(view.state.tr));
    };
    const render = () => {
      if (!alive || resizing) return;
      const bitmap = image(); if (!bitmap) return;
      const width = imageDimension(node.attrs.width), height = imageDimension(node.attrs.height);
      bitmap.alt = String(node.attrs.alt || ''); bitmap.title = String(node.attrs.caption || '');
      for (const [key, value] of [['width', width], ['height', height]] as const) { if (value) bitmap.setAttribute(key, String(value)); else bitmap.removeAttribute(key); }
      const styles: Record<string, string> = { width: '', height: 'auto', 'aspect-ratio': '' };
      for (const declaration of imageSizeStyle({ width, height }).split(';')) {
        const [key, value] = declaration.split(':'); if (key) styles[key] = value;
      }
      for (const [key, value] of Object.entries(styles)) if (bitmap.style.getPropertyValue(key).replace(/\s/g, '') !== value.replace(/\s/g, '')) bitmap.style.setProperty(key, value);
      const operation = dom.querySelector('.operation');
      if (operation) {
        let reset = operation.querySelector<HTMLButtonElement>('.moye-image-reset');
        if (!reset) {
          reset = document.createElement('button'); reset.type = 'button'; reset.className = 'moye-image-reset'; reset.textContent = t("还原尺寸"); reset.title = t("恢复图片原始尺寸");
          reset.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
          reset.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); setSize(null, null); });
          operation.append(reset);
        }
        reset.hidden = !width && !height;
      }
      const handle = dom.querySelector<HTMLElement>('.image-resize-handle');
      if (handle) { handle.title = t("拖动调整图片宽度"); handle.setAttribute('aria-label', t("调整图片尺寸")); handle.hidden = !safeImageSource(node.attrs.src); }
    };
    const onLoad = () => queueMicrotask(render);
    // Crepe measures images asynchronously on load. Reapply model dimensions if
    // that measurement writes a height; compare first to avoid observer loops.
    const observer = new MutationObserver(render); observer.observe(dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    dom.addEventListener('load', onLoad, true);
    const pointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.image-resize-handle') || !editable()) return;
      if (!safeImageSource(node.attrs.src)) return;
      const bitmap = image(); if (!bitmap?.naturalWidth) return;
      event.preventDefault(); event.stopImmediatePropagation();
      cancelDrag?.();
      const box = bitmap.getBoundingClientRect(), original = view.state.doc, start = event.clientY;
      if (!box.width || !box.height) return;
      const aspect = box.width / box.height, max = Math.min(MAX_IMAGE_DIMENSION, Math.max(1, dom.getBoundingClientRect().width));
      let width = Math.round(box.width), height = Math.round(box.height), moved = false;
      const preserveHeight = Boolean(imageDimension(node.attrs.height)); resizing = true;
      const move = (next: PointerEvent) => {
        if (!editable() || view.state.doc !== original) { cancelDrag?.(); return; }
        next.preventDefault(); moved = true;
        width = Math.max(1, Math.min(Math.round((box.height + next.clientY - start) * aspect), Math.round(max)));
        height = Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.round(width / aspect)));
        bitmap.style.width = `${width}px`; bitmap.style.height = `${height}px`; bitmap.style.aspectRatio = '';
      };
      const up = () => {
        const valid = editable() && view.state.doc === original;
        cancelDrag?.();
        if (valid && moved) setSize(width, preserveHeight ? height : null);
      };
      const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); cancel(); } };
      const cancel = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true); resizing = false; cancelDrag = undefined; render(); };
      cancelDrag = cancel;
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
      window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true);
    };
    // Caption text is a title. Commit input synchronously so immediate keyboard Save cannot miss it.
    const input = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches('.caption-input')) return;
      event.stopImmediatePropagation(); const pos = position(); if (pos === undefined || !view.editable) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'caption', event.target.value));
    };
    dom.addEventListener('pointerdown', pointerDown, true); dom.addEventListener('input', input, true); render();
    return {
      ...base,
      update(updated, nextDecorations, nextInner) { if (updated.type !== initial.type || base.update?.(updated, nextDecorations, nextInner) === false) return false; node = updated; render(); queueMicrotask(render); return true; },
      ignoreMutation: () => true,
      destroy() { alive = false; cancelDrag?.(); observer.disconnect(); dom.removeEventListener('load', onLoad, true); dom.removeEventListener('pointerdown', pointerDown, true); dom.removeEventListener('input', input, true); base.destroy?.(); },
    };
  };
}

export const sizedImageBlockView: MilkdownPlugin = ctx => {
  const initialize = imageBlockView(ctx);
  return async () => {
    const cleanup = await initialize(), create = imageView(imageBlockView.view);
    ctx.update(nodeViewCtx, views => views.map(([name, constructor]) => name === 'image-block' ? [name, create] : [name, constructor]));
    return () => { if (typeof cleanup === 'function') return cleanup(); };
  };
};

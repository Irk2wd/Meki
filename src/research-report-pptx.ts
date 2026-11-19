import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer';

export async function openPptxPreview(mount: HTMLElement, bytes: Uint8Array, signal: AbortSignal) {
  let error: unknown;
  const viewer = new PptxViewer(mount, {
    externalMedia: 'block',
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazyMedia: true,
    lazySlides: true,
    fitMode: 'contain',
    pdfjs: false,
    onSlideError: (_index, failure) => { error = failure; },
  });
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    viewer.destroy();
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    await viewer.open(bytes, { renderMode: 'slide', signal });
    signal.throwIfAborted();
    if (error) throw error;
    mount.style.setProperty('--report-aspect', String(viewer.slideWidth / viewer.slideHeight));
    return {
      count: viewer.slideCount,
      async show(pageNumber: number) {
        if (viewer.currentSlideIndex === pageNumber - 1 && !error) return;
        error = undefined;
        await viewer.goToSlide(pageNumber - 1);
        if (error) throw error;
      },
    };
  } catch (error) { dispose(); throw error; }
}

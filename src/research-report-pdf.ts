import { getDocument, PDFWorker } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

export async function openPdfPreview(mount: HTMLElement, bytes: Uint8Array, signal: AbortSignal) {
  const port = new PdfWorker();
  // PDF.js accepts a Worker port but its declaration infers the default null.
  const worker = new PDFWorker({ port } as unknown as ConstructorParameters<typeof PDFWorker>[0]);
  const resources = new URL(import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : './pdf-data/', document.baseURI);
  const directory = (name: string) => new URL(`${name}/`, resources).href;
  const loading = getDocument({
    data: bytes,
    worker,
    cMapUrl: directory('cmaps'),
    standardFontDataUrl: directory('standard_fonts'),
    wasmUrl: directory('wasm'),
    iccUrl: directory('iccs'),
    useWorkerFetch: false,
    useWasm: false,
    maxImageSize: 64_000_000,
  });
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    void loading.destroy().catch(() => {}).finally(() => { worker.destroy(); port.terminate(); });
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const pdf = await loading.promise;
    signal.throwIfAborted();
    return {
      count: pdf.numPages,
      async show(pageNumber: number) {
        const page = await pdf.getPage(pageNumber);
        signal.throwIfAborted();
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1800 / Math.max(1, size.width, size.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const render = page.render({ canvas, viewport });
        const cancel = () => render.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          await render.promise;
          signal.throwIfAborted();
          mount.style.setProperty('--report-aspect', String(size.width / size.height));
          mount.replaceChildren(canvas);
        } finally {
          signal.removeEventListener('abort', cancel);
          page.cleanup();
        }
      },
    };
  } catch (error) { dispose(); throw error; }
}

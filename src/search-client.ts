import { t, getLocale } from '../electron/i18n.mjs';
import type { SearchOptions, SearchResult, SearchSegment } from './search';

export class SearchClient {
  private worker?: Worker;
  private finish?: (result: SearchResult | null) => void;
  cancel() { this.worker?.terminate(); this.worker = undefined; this.finish?.(null); this.finish = undefined; }
  run(segments: SearchSegment[], options: SearchOptions): Promise<SearchResult | null> {
    this.cancel();
    if (!options.query) return Promise.resolve({ matches: [], error: null, truncated: false });
    return new Promise(resolve => {
      let worker: Worker;
      try { worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' }); }
      catch { resolve({ matches: [], error: t("无法启动查找，请重新打开应用。"), truncated: false }); return; }
      this.worker = worker;
      const timer = setTimeout(() => done({ matches: [], error: t("查找耗时过长，请简化正则表达式。"), truncated: false }), 1500);
      const done = (result: SearchResult | null) => { clearTimeout(timer); worker.terminate(); if (this.worker === worker) { this.worker = undefined; this.finish = undefined; } resolve(result); };
      this.finish = done;
      worker.onmessage = event => done(event.data as SearchResult);
      worker.onerror = event => { event.preventDefault(); done({ matches: [], error: t("无法完成查找，请重试。"), truncated: false }); };
      worker.postMessage({ segments, options, locale: getLocale() });
    });
  }
}

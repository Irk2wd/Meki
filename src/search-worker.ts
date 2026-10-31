import { searchText, type SearchOptions, type SearchSegment } from './search';
import { setLocale, type Locale } from '../electron/i18n.mjs';
self.onmessage = (event: MessageEvent<{ segments: SearchSegment[]; options: SearchOptions; locale: Locale }>) => {
  setLocale(event.data.locale);
  self.postMessage(searchText(event.data.segments, event.data.options));
};

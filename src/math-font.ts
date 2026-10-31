import { t } from '../electron/i18n.mjs';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/js/svg.js';
import { MathJaxMhchemFontExtension } from '@mathjax/mathjax-mhchem-font-extension/js/svg.js';
import type { DynamicFile } from '@mathjax/src/js/output/common/FontData.js';

// Explicit imports let Vite bundle every glyph range; TeX never loads a URL.
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js';
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js';

class OfflineMathFont extends MathJaxNewcmFont {
  constructor() {
    super();
    for (const range of Object.values(OfflineMathFont.dynamicFiles)) range.setup(this);
    this.addExtension(MathJaxMhchemFontExtension);
  }

  override loadDynamicFile(_range: DynamicFile): Promise<void> {
    throw new Error(t("此公式需要的字形尚未包含在离线字体中。"));
  }

  override loadDynamicFileSync(_range: DynamicFile): void {
    throw new Error(t("此公式需要的字形尚未包含在离线字体中。"));
  }
}

// Glyph data is shared. Equation tags, macros, IDs and output caches are not.
export const offlineMathFont = new OfflineMathFont();

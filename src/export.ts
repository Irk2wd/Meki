import { getLocale } from '../electron/i18n.mjs';
import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown-render';
import { renderMathDocument } from './math-engine';
import { renderDiagram } from './diagram-engine';
import { writingAppearance } from './appearance';
import extensionCSS from './markdown-extensions.css?inline';
import diagramCSS from './diagrams.css?inline';
import type { Settings } from '../shared/meki';
import { codeDefaults } from './code-options';
import { typingDefaults } from './typing-rules';
import { highlightExportCode } from './code-highlight';

const defaults: Settings = { locale: 'zh-CN', theme: 'paper', font: 'serif', fontSize: 18, lineWidth: 780, focus: false, sidebar: true, customCss: '', fontFamily: '', mathNumbering: 'none', mathPhysics: false, typewriter: false, paragraphFocus: false, spellcheck: false, autoSave: false, autoSaveInterval: 30, autoSaveOnBlur: true, autoSnapshot: true, snapshotInterval: 60, reopenSession: true, codeLineNumbers: true, headingNumbering: false, picgoPort: 36677, imageAutoUpload: false, imageDirectoryBase: 'document', imageDirectory: '${filename}.assets', ...codeDefaults, ...typingDefaults };

export async function exportHTML(markdown: string, name: string, documentPath: string | null, settings: Settings = defaults, wordMath = false) {
  const parsed = renderMarkdown(markdown, settings);
  const holder = document.createElement('div');
  // User HTML is visible escaped source; links and remaining generated HTML are sanitized.
  holder.innerHTML = DOMPurify.sanitize(parsed.html);
  await highlightExportCode(holder);
  const math = renderMathDocument(parsed.expressions, settings, 'meki-export-equation');
  // Only the trusted offline engine can populate these slots, after sanitizing the document.
  for (const slot of holder.querySelectorAll<HTMLElement>('[data-meki-math]')) {
    const result = math.items[Number(slot.dataset.mekiMath)]; if (result) slot.innerHTML = result.html;
    const formula = slot.querySelector<HTMLElement>('.meki-math');
    if (formula?.dataset.mathDisplay === 'false') slot.classList.add('meki-inline-math');
    if (wordMath && formula && result && !result.error) {
      formula.dataset.mekiWordFormula = '1';
      if (result.docxMathml) formula.dataset.mekiWordMath = result.docxMathml;
    }
    delete slot.dataset.mekiMath;
  }
  await Promise.all([...holder.querySelectorAll<HTMLElement>('[data-meki-diagram]')].map(async slot => {
    const index = Number(slot.dataset.mekiDiagram), source = parsed.diagrams[index];
    if (source !== undefined) slot.innerHTML = (await renderDiagram(source, { theme: settings.theme, id: `export-${index}` })).html;
    delete slot.dataset.mekiDiagram;
  }));
  await Promise.all([...holder.querySelectorAll('img')].map(async img => {
    const source = img.getAttribute('src'); if (source) img.src = await window.meki.assetUrl(source, documentPath);
  }));
  const title = name.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const appearance = writingAppearance(settings, { scope: '.meki-document', exporting: true });
  const background = settings.theme === 'night' ? '#202521' : settings.theme === 'linen' ? '#faf6ee' : '#fff';
  const css = `${appearance}\n${extensionCSS}\n${diagramCSS}\n${math.css}`.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http: file:; style-src 'unsafe-inline'; font-src data:;"><title>${title}</title><style>html,body{background:${background};print-color-adjust:exact;-webkit-print-color-adjust:exact}body{margin:0;padding:48px 24px}.meki-document{margin:auto;max-width:${settings.lineWidth || 780}px}.meki-document img{max-width:100%}@page{background:${background}}@media print{body{padding:0}}\n${css}</style></head><body><article class="meki-document">${holder.innerHTML}</article></body></html>`;
}

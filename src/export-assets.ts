import { t, ht } from '../electron/i18n.mjs';
import type { ExportKind } from '../shared/export';

function dimensions(svg: SVGSVGElement) {
  const box = svg.getBoundingClientRect();
  const width = box.width || svg.viewBox.baseVal.width, height = box.height || svg.viewBox.baseVal.height;
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0 || width > 8192 || height > 20000) throw new Error(t("图形尺寸过大或无效。"));
  return { width, height };
}
export function standaloneSvg(svg: SVGSVGElement) {
  const { width, height } = dimensions(svg), clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', String(width)); clone.setAttribute('height', String(height));
  clone.style.width = `${width}px`; clone.style.height = `${height}px`; clone.style.maxWidth = 'none';
  clone.style.color = getComputedStyle(svg).color;
  return { svg: new XMLSerializer().serializeToString(clone), width, height };
}
export async function svgPng(svg: SVGSVGElement, scale = 3) {
  const image = standaloneSvg(svg);
  if (image.width * image.height * scale * scale > 40_000_000 || image.height * scale > 20000 || image.width * scale > 8192) throw new Error(t("图表图片超过尺寸限制，请缩小图表后重试。"));
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(image.width * scale); canvas.height = Math.ceil(image.height * scale);
  const url = URL.createObjectURL(new Blob([image.svg], { type: 'image/svg+xml' }));
  try {
    const bitmap = new Image(); bitmap.src = url; await bitmap.decode();
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png');
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), value => value.charCodeAt(0));
    return { data, bytes, width: Math.ceil(image.width), height: Math.ceil(image.height) };
  } finally { URL.revokeObjectURL(url); canvas.width = canvas.height = 0; }
}

/** Word keeps a raster fallback beside its candidate MathML; other portable formats use the raster. */
export async function prepareExportAssets(html: string, kind: ExportKind) {
  if (kind === 'html') return html;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const image of parsed.images) if (!/^data:image\//i.test(image.getAttribute('src') || '')) throw new Error(t("无法离线读取图片：{0}。请使用当前文稿目录中的本地图片。", (image.getAttribute('src') || image.alt).slice(0, 160)));
  if (kind === 'pdf' || kind === 'png') return html;
  const iframe = document.createElement('iframe'); iframe.setAttribute('sandbox', 'allow-same-origin'); iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, { position: 'fixed', left: '-20000px', top: '0', width: '960px', height: '800px', visibility: 'hidden' });
  document.body.append(iframe);
  try {
    const loaded = new Promise<void>((resolve, reject) => { iframe.onload = () => resolve(); iframe.onerror = () => reject(new Error(t("导出快照无法加载。"))); });
    iframe.srcdoc = html.replace(/<head[^>]*>/i, match => match + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:;">');
    await loaded;
    const doc = iframe.contentDocument!; await doc.fonts.ready;
    for (const svg of doc.querySelectorAll<SVGSVGElement>('.moye-math svg, .moye-diagram svg')) {
      const raster = await svgPng(svg); const image = doc.createElement('img'); image.src = raster.data;
      image.width = raster.width; image.height = raster.height; image.alt = svg.closest('.moye-diagram') ? t("Mermaid 图表") : svg.closest('.moye-math')?.getAttribute('aria-label') || t("数学公式");
      svg.replaceWith(image);
    }
    for (const image of Array.from(doc.images)) {
      if (/^data:image\/(?:png|jpeg|gif|webp);/i.test(image.src)) continue;
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      if (!canvas.width || !canvas.height || canvas.width > 8192 || canvas.height > 20000 || canvas.width * canvas.height > 40_000_000) throw new Error(t("文稿图片尺寸过大。"));
      canvas.getContext('2d')!.drawImage(image, 0, 0); image.src = canvas.toDataURL('image/png'); canvas.width = canvas.height = 0;
    }
    // CSS-generated section numbers must become text before semantic exports drop CSS.
    for (const heading of doc.querySelectorAll('h1[data-heading-number],h2[data-heading-number],h3[data-heading-number],h4[data-heading-number],h5[data-heading-number],h6[data-heading-number]')) {
      const number = heading.getAttribute('data-heading-number') || '';
      if (/^\d+(?:\.\d+)*$/.test(number)) heading.prepend(doc.createTextNode(`${number} `));
      heading.removeAttribute('data-heading-number');
    }
    // Preserve semantic HTML only; diagram/formula appearance lives in their PNGs.
    doc.querySelectorAll('article,mjx-container,mjx-break').forEach(node => node.replaceWith(...node.childNodes));
    doc.querySelectorAll('style,script').forEach(node => node.remove());
    doc.querySelectorAll('*').forEach(node => { for (const attr of Array.from(node.attributes)) {
      if (kind === 'docx' && ['data-moye-word-formula', 'data-moye-word-math'].includes(attr.name)) continue;
      if (attr.name === 'class' || attr.name === 'style' || attr.name.startsWith('data-')) node.removeAttribute(attr.name);
    } });
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  } finally { iframe.remove(); }
}

export function installDiagramActions(notify: (message: string, error?: boolean) => void) {
  const menu = document.createElement('div'); menu.className = 'diagram-save-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  menu.innerHTML = `<button type="button" data-diagram-save="svg">${ht("另存 SVG")}</button><button type="button" data-diagram-save="png">${ht("另存 PNG")}</button><button type="button" data-diagram-save="clipboard">${ht("复制图片")}</button>`;
  document.body.append(menu); let active: SVGSVGElement | null = null;
  const open = (svg: SVGSVGElement, x: number, y: number) => { active = svg; menu.hidden = false; menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`; menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`; };
  const refresh = () => document.querySelectorAll<HTMLElement>('.ProseMirror .moye-diagram[data-diagram-state="ready"]').forEach(diagram => {
    if (diagram.querySelector('.diagram-actions')) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'diagram-actions'; button.textContent = '⋯'; button.title = t("图表另存与复制"); button.setAttribute('aria-label', button.title); button.contentEditable = 'false';
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); const box = button.getBoundingClientRect(); open(diagram.querySelector('svg')!, box.left, box.bottom); });
    diagram.append(button);
  });
  const observer = new MutationObserver(refresh); observer.observe(document.querySelector('#editor-workspace')!, { childList: true, subtree: true }); refresh();
  document.addEventListener('contextmenu', event => { const svg = (event.target as Element).closest<SVGSVGElement>('.ProseMirror .moye-diagram svg'); if (svg) { event.preventDefault(); open(svg, event.clientX, event.clientY); } });
  document.addEventListener('click', event => { if (!menu.contains(event.target as Node)) menu.hidden = true; });
  menu.addEventListener('click', async event => {
    const kind = (event.target as Element).closest<HTMLElement>('[data-diagram-save]')?.dataset.diagramSave as 'svg' | 'png' | 'clipboard' | undefined;
    if (!kind || !active) return; menu.hidden = true;
    try { const snapshot = active; const result = await window.moye.saveDiagram(kind === 'svg' ? { kind, svg: standaloneSvg(snapshot).svg } : { kind, png: (await svgPng(snapshot, 2)).bytes }); if (result || kind === 'clipboard') notify(kind === 'clipboard' ? t("已复制图表图片") : t("已保存图表 {0}", kind.toUpperCase())); }
    catch (error) { notify(String(error), true); }
  });
}

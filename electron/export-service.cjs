'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, dialog, clipboard, ClipboardItem, nativeImage, app } = require('electron');
const { atomicWrite, validateAbsolutePath, pathKey } = require('./file-store.cjs');
const { validateExport, validateRaster, validateDiagramSvg, pdfPrintOptions } = require('./export-policy.cjs');
const { PandocService } = require('./pandoc-service.cjs');
const { ExportPresets } = require('./export-presets.cjs');
const TEST = process.env.MEKI_TEST === '1';

function createExportService(getWindow, getActiveDocument, store) {
  const pandoc = new PandocService(app.getPath('userData'));
  const presets = new ExportPresets(store);
  const importedPaths = new Set();
  let exporting = false, presetsReady = null;
  async function presetStore() {
    // Presets are optional: a damaged index must never prevent normal editing or basic export.
    if (!presetsReady) presetsReady = presets.init().catch(error => { presetsReady = null; throw error; });
    await presetsReady; return presets;
  }
  async function outputPath(kind, name, testKey) {
    let selected;
    if (TEST) selected = process.env[testKey] || process.env.MEKI_TEST_EXPORT_PATH;
    else {
      const stem = path.parse(name || t("未命名")).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 160);
      const result = await dialog.showSaveDialog(getWindow(), { title: t("导出 {0}", kind.toUpperCase()), defaultPath: `${stem}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (result.canceled) return null; selected = result.filePath;
    }
    if (!selected) return null;
    selected = validateAbsolutePath(selected);
    if (path.extname(selected).toLowerCase() !== `.${kind}`) throw new Error(t("请选择 .{0} 文件。", kind));
    const actual = await fs.realpath(selected).catch(() => selected);
    if (importedPaths.has(pathKey(actual)) || getActiveDocument().path && pathKey(actual) === pathKey(getActiveDocument().path)) throw new Error(t("请使用不同文件名，不能覆盖导入的原文件或当前 Markdown。"));
    return selected;
  }
  async function withSnapshot(html, width, action) {
    const temporaryRoot = await fs.realpath(app.getPath('temp'));
    const folder = await fs.mkdtemp(path.join(temporaryRoot, 'meki-export-'));
    const file = path.join(folder, 'snapshot.html');
    let win, deadline;
    try {
      // The first CSP remains restrictive even if the snapshot contains another policy.
      const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\';">';
      const source = '<!doctype html>' + policy + html;
      await fs.writeFile(file, source);
      win = new BrowserWindow({ show: false, width, height: 800, webPreferences: { partition: `meki-export-${crypto.randomUUID()}`, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
      const contents = win.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
      contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.resourceType === 'mainFrame' && details.url.startsWith('file:') && pathKey(require('node:url').fileURLToPath(details.url)) === pathKey(file)) && !details.url.startsWith('data:') }));
      return await Promise.race([
        (async () => {
          await win.loadFile(file);
          try { await contents.executeJavaScript('Promise.all([document.fonts.ready,...Array.from(document.images, image => image.decode())]).then(() => true)'); }
          catch { throw new Error(t("导出快照中的图片无法解码或被阻止，请检查图片是否可离线读取。")); }
          return action(contents);
        })(),
        new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(t("文稿渲染超过 45 秒，请缩短文稿后重试。"))), 45_000); }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (win && !win.isDestroyed()) win.destroy();
      if (path.dirname(folder) !== temporaryRoot || !path.basename(folder).startsWith('meki-export-')) throw new Error('Invalid temporary directory');
      await fs.rm(folder, { recursive: true, force: true });
    }
  }
  async function exportFile(raw) {
    const input = validateExport(raw);
    if (exporting) throw new Error(t("正在导出，请等待完成。")); exporting = true;
    try {
      const extension = input.kind === 'plain-html' ? 'html' : input.kind;
      const selected = await outputPath(extension, input.suggestedName, `MEKI_TEST_EXPORT_${input.kind.replace('-', '_').toUpperCase()}_PATH`);
      if (!selected) return null;
      let bytes;
      if (['html', 'plain-html'].includes(input.kind)) bytes = Buffer.from(input.html);
      else if (input.kind === 'docx' || input.kind === 'epub') {
        const reference = input.kind === 'docx' && input.referenceId ? await (await presetStore()).readReference(input.referenceId) : null;
        bytes = await pandoc.exportDocument(input.html, input.kind, input.suggestedName, reference);
      }
      else bytes = await withSnapshot(input.html, input.pngWidth, async contents => {
        if (input.kind === 'pdf') {
          const color = await contents.executeJavaScript('getComputedStyle(document.querySelector(".meki-document") || document.body).color');
          return contents.printToPDF(pdfPrintOptions(input.pdf, input.suggestedName, color));
        }
        const height = await contents.executeJavaScript('Math.ceil(Math.max(document.body.getBoundingClientRect().bottom, document.body.scrollHeight))');
        validateRaster(input.pngWidth, height, input.pngScale);
        contents.debugger.attach('1.3');
        try {
          await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: input.pngWidth, height: 800, deviceScaleFactor: input.pngScale, mobile: false });
          const shot = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width: input.pngWidth, height, scale: 1 } });
          return Buffer.from(shot.data, 'base64');
        } finally { if (!contents.isDestroyed()) contents.debugger.detach(); }
      });
      await atomicWrite(selected, bytes); return { path: selected, ...(input.kind === 'docx' ? { math: pandoc.lastMathExport } : {}) };
    } finally { exporting = false; }
  }
  async function saveDiagram(input) {
    if (!input || !['svg', 'png', 'clipboard'].includes(input.kind) || Object.keys(input).some(key => !['kind', 'svg', 'png'].includes(key))) throw new TypeError(t("图表导出参数不正确。"));
    let bytes;
    if (input.kind === 'svg') {
      bytes = Buffer.from(validateDiagramSvg(input.svg));
    } else {
      if (!(input.png instanceof Uint8Array) || input.png.byteLength > 40 * 1024 * 1024) throw new TypeError(t("图片过大。"));
      bytes = Buffer.from(input.png);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(t("不是有效的 PNG。"));
      validateRaster(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
      const image = nativeImage.createFromBuffer(bytes); const size = image.getSize(); validateRaster(size.width, size.height);
      if (input.kind === 'clipboard') { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]); return null; }
    }
    const selected = await outputPath(input.kind, t("图表"), `MEKI_TEST_DIAGRAM_${input.kind.toUpperCase()}_PATH`);
    if (selected) await atomicWrite(selected, bytes); return selected;
  }
  async function choosePandoc() {
    let selected;
    if (TEST) selected = process.env.MEKI_PANDOC_PATH;
    else { const result = await dialog.showOpenDialog(getWindow(), { title: t("选择 Pandoc 可执行文件（3.12.1 或更新）"), properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Pandoc', extensions: ['exe'] }] } : {}) }); if (!result.canceled) selected = result.filePaths[0]; }
    return selected ? pandoc.setExecutable(selected) : pandoc.status();
  }
  async function chooseExportReference() {
    let selected;
    if (TEST) selected = process.env.MEKI_TEST_REFERENCE_PATH;
    else {
      const result = await dialog.showOpenDialog(getWindow(), { title: t("选择 Word 样式模板"), properties: ['openFile'], filters: [{ name: t("Word 样式模板"), extensions: ['docx'] }] });
      if (!result.canceled) selected = result.filePaths[0];
    }
    if (!selected) return null;
    const template = await (await presetStore()).importReference(selected);
    importedPaths.add(pathKey(await fs.realpath(selected).catch(() => selected)));
    return template;
  }
  async function importDocument() {
    let selected;
    if (TEST) selected = process.env.MEKI_TEST_IMPORT_PATH;
    else { const result = await dialog.showOpenDialog(getWindow(), { title: t("导入为新 Markdown 文稿"), properties: ['openFile'], filters: [{ name: 'Word / HTML', extensions: ['docx', 'html', 'htm'] }] }); if (!result.canceled) selected = result.filePaths[0]; }
    if (!selected) return null;
    const actual = await fs.realpath(validateAbsolutePath(selected)); const result = await pandoc.importDocument(actual); importedPaths.add(pathKey(actual)); return result;
  }
  return {
    exportFile, saveDiagram, choosePandoc, importDocument, exportTools: () => pandoc.status(), chooseExportReference,
    listExportPresets: async () => (await presetStore()).list(),
    saveExportPreset: async input => (await presetStore()).save(input),
    deleteExportPreset: async id => (await presetStore()).delete(id),
    deleteExportReference: async id => (await presetStore()).deleteReference(id),
  };
}
module.exports = { createExportService };

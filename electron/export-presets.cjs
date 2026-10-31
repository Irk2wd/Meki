'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite, validateAbsolutePath, digest } = require('./file-store.cjs');
const { validateDocx, LIMITS: DOCX_LIMITS } = require('./docx-template.cjs');
const LIMITS = Object.freeze({ presets: 20, templates: 20, indexBytes: 128 * 1024, templateTotalBytes: 64 * 1024 * 1024 });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const pdfDefaults = Object.freeze({ pageSize: 'A4', landscape: false, margin: 19, pageNumbers: false, header: false, pageBreakBeforeH1: false });
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 60 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(t("预设名称需为 1–60 个字符，不能包含换行。"));
  return value.trim();
}
function validatePresetOptions(input) {
  if (!object(input) || Object.keys(input).some(key => !['kind', 'pdf', 'pngWidth', 'pngScale', 'theme', 'fontSize', 'referenceId'].includes(key))) throw new Error(t("导出预设参数不正确。"));
  if (!['html', 'plain-html', 'pdf', 'png', 'docx', 'epub'].includes(input.kind)) throw new Error(t("不支持此导出格式。"));
  if (input.pdf !== undefined && (!object(input.pdf) || Object.keys(input.pdf).some(key => !Object.hasOwn(pdfDefaults, key)))) throw new Error(t("PDF 设置不正确。"));
  const pdf = { ...pdfDefaults, ...input.pdf };
  if (!['A4', 'Letter', 'A5'].includes(pdf.pageSize) || !['landscape', 'pageNumbers', 'header', 'pageBreakBeforeH1'].every(key => typeof pdf[key] === 'boolean') || !Number.isFinite(pdf.margin) || pdf.margin < 5 || pdf.margin > 40 || (pdf.header || pdf.pageNumbers) && pdf.margin < 12) throw new Error(t("PDF 页边距需为 5–40 毫米，使用页眉页码时至少 12 毫米。"));
  const pngWidth = input.pngWidth ?? 960, pngScale = input.pngScale ?? 2, theme = input.theme ?? 'current', fontSize = input.fontSize ?? null, referenceId = input.referenceId ?? null;
  if (!Number.isInteger(pngWidth) || pngWidth < 640 || pngWidth > 1600 || ![1, 2].includes(pngScale)) throw new Error(t("PNG 宽度需为 640–1600 px，倍率为 1 或 2。"));
  if (!['current', 'paper', 'linen', 'night'].includes(theme) || fontSize !== null && (!Number.isFinite(fontSize) || fontSize < 12 || fontSize > 32)) throw new Error(t("导出主题或字号不正确。"));
  if (referenceId !== null && !uuid(referenceId)) throw new Error(t("Word 模板 ID 不正确。"));
  return { kind: input.kind, pdf, pngWidth, pngScale, theme, fontSize, referenceId };
}
function validateState(input) {
  if (!object(input) || input.version !== 1 || !Array.isArray(input.presets) || !Array.isArray(input.templates) || input.presets.length > LIMITS.presets || input.templates.length > LIMITS.templates || Object.keys(input).some(key => !['version', 'presets', 'templates'].includes(key))) throw new Error(t("导出预设索引格式或容量不正确。"));
  const templateIds = new Set(), presetIds = new Set(), names = new Set(); let bytes = 0;
  const templates = input.templates.map(value => {
    if (!object(value) || !uuid(value.id) || templateIds.has(value.id) || typeof value.name !== 'string' || !value.name || value.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(value.name) || !/\.docx$/i.test(value.name) || !Number.isSafeInteger(value.size) || value.size < 22 || value.size > DOCX_LIMITS.archiveBytes || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error(t("Word 模板索引记录不正确。"));
    templateIds.add(value.id); bytes += value.size;
    return { id: value.id, name: value.name, size: value.size, sha256: value.sha256, createdAt: value.createdAt };
  });
  if (bytes > LIMITS.templateTotalBytes) throw new Error(t("Word 模板总大小超过 64 MiB，请先删除不用的模板。"));
  const presets = input.presets.map(value => {
    if (!object(value) || !uuid(value.id) || presetIds.has(value.id) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new Error(t("导出预设记录不正确。"));
    const name = label(value.name), nameKey = name.normalize('NFKC').toLowerCase(), options = validatePresetOptions(value.options);
    if (names.has(nameKey) || options.referenceId && !templateIds.has(options.referenceId)) throw new Error(t("导出预设名称重复或 Word 模板不存在。"));
    presetIds.add(value.id); names.add(nameKey);
    return { id: value.id, name, options, updatedAt: value.updatedAt };
  });
  const state = { version: 1, presets, templates };
  if (Buffer.byteLength(JSON.stringify(state)) > LIMITS.indexBytes) throw new Error(t("导出预设索引超过 128 KiB。"));
  return state;
}
async function regular(file, missing = false) {
  const info = await fs.lstat(file).catch(error => { if (missing && error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error(t("导出设置与模板不能是链接或特殊文件。"));
  return info;
}
async function readRegular(file, maximum) {
  const before = await regular(file);
  if (before.size > maximum) throw new Error(t("导出设置或模板超过容量限制。"));
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error(t("读取期间模板或设置发生变化，请重试。"));
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > maximum || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(t("读取期间模板或设置发生变化，请重试。"));
    return bytes;
  } finally { await handle.close(); }
}
class ExportPresets {
  constructor(store) {
    this.store = store; this.root = path.join(store.userData, 'export-presets-v1');
    this.templatesRoot = path.join(this.root, 'templates'); this.indexPath = path.join(this.root, 'index.json');
  }
  async guards() {
    for (const folder of [this.root, this.templatesRoot]) {
      const info = await fs.lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(t("导出预设目录不能是链接或特殊文件。"));
    }
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    const rootInfo = await fs.lstat(this.root); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(t("导出预设目录不能是链接。"));
    await fs.mkdir(this.templatesRoot, { recursive: true });
    await this.guards(); return this.list();
  }
  async readState() {
    await this.guards(); const info = await regular(this.indexPath, true);
    if (!info) return { version: 1, presets: [], templates: [] };
    try { return validateState(JSON.parse((await readRegular(this.indexPath, LIMITS.indexBytes)).toString('utf8'))); }
    catch (error) { throw new Error(t("导出预设暂不可用，原数据已保留：{0}", error.message)); }
  }
  async commit(state) {
    const validated = validateState(state); await this.guards(); await regular(this.indexPath, true);
    await atomicWrite(this.indexPath, Buffer.from(JSON.stringify(validated)), { beforeCommit: async () => { await this.guards(); await regular(this.indexPath, true); } });
  }
  async list() { return this.store.locked('export-presets', async () => { const { presets, templates } = await this.readState(); return clone({ presets, templates }); }); }
  async save(input) {
    if (!object(input) || Object.keys(input).some(key => !['id', 'name', 'options'].includes(key)) || input.id !== undefined && !uuid(input.id)) throw new Error(t("导出预设格式不正确。"));
    const name = label(input.name), options = validatePresetOptions(input.options);
    return this.store.locked('export-presets', async () => {
      const state = await this.readState(), index = input.id ? state.presets.findIndex(item => item.id === input.id) : -1;
      if (input.id && index < 0) throw new Error(t("此预设已被删除，请另存为新预设。"));
      const preset = { id: input.id || randomUUID(), name, options, updatedAt: Date.now() };
      if (index < 0) { if (state.presets.length >= LIMITS.presets) throw new Error(t("最多保存 20 个导出预设，请先删除不用的预设。")); state.presets.push(preset); }
      else state.presets[index] = preset;
      await this.commit(state); return clone(preset);
    });
  }
  async delete(id) {
    if (!uuid(id)) throw new Error(t("预设 ID 不正确。"));
    return this.store.locked('export-presets', async () => {
      const state = await this.readState(); if (!state.presets.some(item => item.id === id)) return false;
      state.presets = state.presets.filter(item => item.id !== id); await this.commit(state); return true;
    });
  }
  async importReference(selected) {
    selected = validateAbsolutePath(selected);
    if (path.extname(selected).toLowerCase() !== '.docx' || path.basename(selected).length > 180) throw new Error(t("请选择名称不超过 180 字符的 .docx 样式模板。"));
    const bytes = await readRegular(selected, DOCX_LIMITS.archiveBytes); validateDocx(bytes); const sha256 = digest(bytes);
    return this.store.locked('export-presets', async () => {
      const state = await this.readState(), existing = state.templates.find(item => item.sha256 === sha256);
      if (existing) { await this.referenceBytes(existing); return clone(existing); }
      if (state.templates.length >= LIMITS.templates) throw new Error(t("最多保留 20 个 Word 模板，请先删除不用的模板。"));
      const template = { id: randomUUID(), name: path.basename(selected), size: bytes.length, sha256, createdAt: Date.now() };
      const next = { ...state, templates: [...state.templates, template] }; validateState(next);
      await this.guards(); const filename = path.join(this.templatesRoot, `${template.id}.docx`);
      const handle = await fs.open(filename, 'wx', 0o600); let identity;
      try {
        try { identity = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await this.commit(next);
      } catch (error) { if (identity) await this.removeOwned(filename, identity).catch(() => {}); throw error; }
      return clone(template);
    });
  }
  async removeOwned(filename, identity) {
    await this.guards(); const now = await regular(filename, true);
    if (now && now.ino === identity.ino && now.dev === identity.dev) await fs.unlink(filename);
  }
  async referenceBytes(template) {
    await this.guards(); const filename = path.join(this.templatesRoot, `${template.id}.docx`), bytes = await readRegular(filename, DOCX_LIMITS.archiveBytes);
    if (bytes.length !== template.size || digest(bytes) !== template.sha256) throw new Error(t("Word 模板副本已损坏或被修改，请重新选择模板。"));
    validateDocx(bytes); return bytes;
  }
  async readReference(id) {
    if (!uuid(id)) throw new Error(t("Word 模板 ID 不正确。"));
    return this.store.locked('export-presets', async () => {
      const state = await this.readState(), template = state.templates.find(item => item.id === id);
      if (!template) throw new Error(t("Word 模板已不存在，请重新选择。")); return this.referenceBytes(template);
    });
  }
  async deleteReference(id) {
    if (!uuid(id)) throw new Error(t("Word 模板 ID 不正确。"));
    return this.store.locked('export-presets', async () => {
      const state = await this.readState(), template = state.templates.find(item => item.id === id); if (!template) return false;
      if (state.presets.some(item => item.options.referenceId === id)) throw new Error(t("此模板仍被导出预设使用，请先修改或删除对应预设。"));
      await this.guards(); const filename = path.join(this.templatesRoot, `${id}.docx`), identity = await regular(filename, true);
      state.templates = state.templates.filter(item => item.id !== id); await this.commit(state);
      if (identity) await this.removeOwned(filename, identity); return true;
    });
  }
}
module.exports = { ExportPresets, validatePresetOptions, validateState, pdfDefaults, LIMITS };

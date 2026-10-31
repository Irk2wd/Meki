'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_DIRECTORY = '${filename}.assets';
const FORBIDDEN = new Set(['.git', '.hg', '.svn', 'node_modules', '.moye', '.next', '.cache', '$recycle.bin', 'system volume information']);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (value, root) => { const relative = path.relative(key(root), key(value)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const same = (first, second) => first.dev === second.dev && first.ino === second.ino;
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };

function safeSegment(value) {
  if (!value || value.length > 240 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || ['.', '..'].includes(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || FORBIDDEN.has(value.toLowerCase())) throw new Error(t("图片目录包含无效或受保护的文件夹名称。"));
  return value;
}
function normalizeDestinationSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(t("无效的图片目录设置。"));
  const base = input.base ?? 'document', directory = input.directory ?? DEFAULT_DIRECTORY;
  if (!['document', 'workspace'].includes(base) || typeof directory !== 'string' || !directory || directory.length > 512 || directory !== directory.trim() || /^[\\/]/.test(directory) || /[\x00-\x1f]/.test(directory)) throw new Error(t("图片目录需为文稿或工作区内的相对路径。"));
  const normalized = directory.replace(/\\/g, '/');
  if (normalized === '.') return { base, directory: normalized };
  const sample = normalized.replace(/\$\{filename\}/g, 'document');
  if (/[{}]/.test(sample) || sample.split('/').length > 8) throw new Error(t("图片目录仅支持 ${filename} 占位符，最多 8 层。"));
  sample.split('/').forEach(safeSegment);
  return { base, directory: normalized };
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32767 || /[\x00-\x1f]/.test(value)) throw new Error(t("请选择有效的本地路径。"));
  return path.resolve(value);
}
async function checkRoot(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || key(await fs.realpath(root)) !== key(root)) throw new Error(t("图片目录的授权位置已变化，请重新打开文件夹。"));
}
async function inspectChain(root, target, allowMissing = false, file = false) {
  if (!within(target, root)) throw new Error(t("图片目录必须位于授权文件夹内。"));
  await checkRoot(root);
  let current = root, absent = false;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    safeSegment(part); current = path.join(current, part);
    if (absent) continue;
    const stat = await fs.lstat(current).catch(missing);
    if (!stat) { if (allowMissing) { absent = true; continue; } throw new Error(t("图片目标文件夹不存在。")); }
    if (stat.isSymbolicLink() || (file && index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) || key(await fs.realpath(current)) !== key(current)) throw new Error(t("图片路径不能包含链接或非普通文件夹。"));
  }
}
async function resolveImageDestination({ documentPath, workspaceRoot = null, boundaryRoot = null, base, directory } = {}) {
  // documentPath and authorization roots come from the main process, never an arbitrary renderer payload.
  const settings = normalizeDestinationSettings({ base, directory });
  documentPath = absolute(documentPath);
  const documentDirectory = path.dirname(documentPath);
  workspaceRoot = workspaceRoot ? absolute(workspaceRoot) : null;
  const root = absolute(boundaryRoot || (workspaceRoot && within(documentPath, workspaceRoot) ? workspaceRoot : documentDirectory));
  await inspectChain(root, documentPath, false, true);
  if (settings.base === 'workspace' && (!workspaceRoot || !within(documentPath, workspaceRoot) || !within(workspaceRoot, root))) throw new Error(t("此图片目录需要先打开包含当前文稿的工作区。"));
  const basePath = settings.base === 'workspace' ? workspaceRoot : documentDirectory;
  const filename = path.parse(documentPath).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'document';
  const expanded = settings.directory.replace(/\$\{filename\}/g, filename);
  if (expanded !== '.') expanded.split('/').forEach(safeSegment);
  const target = path.resolve(basePath, expanded);
  await inspectChain(root, target, true);
  const rootStat = await fs.lstat(root);
  return { root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, documentPath, basePath, target, relativePath: path.relative(documentDirectory, target).split(path.sep).join('/'), settings };
}
async function rollbackImageDirectories(created, root) {
  root = absolute(root); let retained = false;
  for (const record of [...created].reverse()) {
    try {
      const target = absolute(record.path);
      if (key(target) === key(root) || !within(target, root)) { retained = true; continue; }
      if (!await fs.lstat(target).catch(missing)) continue;
      await inspectChain(root, target);
      const stat = await fs.lstat(target);
      if (!same(stat, record.stat)) { retained = true; continue; }
      await fs.rmdir(target);
    } catch (error) { if (error.code !== 'ENOENT') retained = true; }
  }
  return retained;
}
async function ensureImageDestination(plan) {
  if (!plan || !plan.root || !plan.target || !plan.documentPath) throw new Error(t("图片目录预览已失效。"));
  const fresh = await resolveImageDestination({ documentPath: plan.documentPath, workspaceRoot: plan.settings?.base === 'workspace' ? plan.basePath : null, boundaryRoot: plan.root, ...plan.settings });
  if (key(fresh.target) !== key(plan.target) || !plan.rootIdentity || !same(fresh.rootIdentity, plan.rootIdentity)) throw new Error(t("图片目录已变化，请重新操作。"));
  const created = [];
  try {
    let current = fresh.root;
    for (const part of path.relative(fresh.root, fresh.target).split(path.sep).filter(Boolean)) {
      await inspectChain(fresh.root, current); current = path.join(current, part);
      try { await fs.mkdir(current); created.push({ path: current, stat: await fs.lstat(current) }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await inspectChain(fresh.root, current);
    }
    return { ...fresh, created };
  } catch (error) {
    const retained = await rollbackImageDirectories(created, fresh.root);
    if (retained) throw new Error(t("{0} 新建目录已被修改，已保留。", error.message));
    throw error;
  }
}
module.exports = { DEFAULT_DIRECTORY, normalizeDestinationSettings, resolveImageDestination, ensureImageDestination, rollbackImageDirectories };

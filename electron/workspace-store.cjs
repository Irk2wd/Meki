'use strict';
const { t } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateAbsolutePath, isWithin, pathKey, isDocumentPath, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');

const EXCLUDED = new Set(['.git', '.hg', '.svn', 'node_modules', '.moye', '.next', '.cache', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_TREE_FILES = 500;
const MAX_TREE_NODES = 2000;
const MAX_OPERATION_NODES = 5000;
const MAX_COPY_BYTES = 256 * 1024 * 1024;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const excluded = name => [...EXCLUDED].some(entry => entry.toLowerCase() === name.toLowerCase());

function allowedName(name) {
  // Keep names portable across Windows/macOS, and reject device names and alternate data streams.
  if (typeof name !== 'string' || !name || name.length > 240 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || ['.', '..'].includes(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) || excluded(name)) throw new Error(t("请输入有效的文件或文件夹名称，不能包含路径或系统保留名称。"));
  return name;
}

class WorkspaceStore {
  constructor(root) { this.root = root; }
  static async open(root) {
    root = await fs.realpath(validateAbsolutePath(root));
    if (!(await fs.stat(root)).isDirectory()) throw new Error(t("请选择文件夹。"));
    return new WorkspaceStore(root);
  }

  async existing(input, { root = false, document = false } = {}) {
    const target = validateAbsolutePath(input);
    if (!isWithin(target, this.root) || (!root && pathKey(target) === pathKey(this.root))) throw new Error(t("操作必须位于当前工作区内，不能操作工作区根目录。"));
    // Resolve every component: a symlink/junction must never turn an authorized lexical path into another location.
    if (pathKey(await fs.realpath(this.root)) !== pathKey(this.root)) throw new Error(t("工作区位置已改变，请重新打开。"));
    let cursor = this.root;
    const relative = path.relative(this.root, target);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      if (excluded(part)) throw new Error(t("不能操作受保护的目录。"));
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(t("为避免越界，工作区操作不跟随符号链接。"));
    }
    const canonical = await fs.realpath(target);
    if (!isWithin(canonical, this.root)) throw new Error(t("路径不在当前工作区内。"));
    const stat = await fs.lstat(canonical);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(t("只支持普通文件和目录。"));
    if (document && (!stat.isFile() || !isDocumentPath(canonical))) throw new Error(t("请选择 Markdown 或文本文件。"));
    return { path: canonical, stat };
  }

  async target(parent, name) {
    allowedName(name);
    const directory = await this.existing(parent, { root: true });
    if (!directory.stat.isDirectory()) throw new Error(t("目标位置必须是文件夹。"));
    const target = path.join(directory.path, name);
    const entry = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (entry) throw new Error(t("目标名称已存在，Meki不会覆盖已有文件。"));
    return target;
  }

  async snapshot(limit = MAX_TREE_FILES) {
    await this.existing(this.root, { root: true });
    const tree = [], entries = [];
    let truncated = false;
    const visit = async directory => {
      let children;
      try { children = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (directory === this.root) throw error; return; }
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en', { numeric: true }));
      for (const child of children) {
        if (entries.length >= limit || tree.length >= MAX_TREE_NODES) { truncated = true; return; }
        if (child.isSymbolicLink() || excluded(child.name) || child.name.toLowerCase().endsWith('.assets') || (!child.isDirectory() && !isDocumentPath(child.name))) continue;
        const candidate = path.join(directory, child.name);
        let item;
        try { item = await this.existing(candidate); } catch { continue; }
        const entry = { path: item.path, name: child.name, relativePath: path.relative(this.root, item.path).split(path.sep).join('/'), parentPath: directory, kind: item.stat.isDirectory() ? 'directory' : 'file', modifiedAt: item.stat.mtimeMs, size: item.stat.size };
        tree.push(entry);
        if (entry.kind === 'directory') await visit(entry.path);
        else entries.push(entry);
      }
    };
    await visit(this.root);
    return { root: this.root, tree, entries, truncated };
  }

  async inspectTree(source, copying = false) {
    let nodes = 0, bytes = 0;
    const visit = async file => {
      if (++nodes > MAX_OPERATION_NODES) throw new Error(t("目录超过 5,000 项，请在系统文件管理器中操作。"));
      const entry = await this.existing(file);
      if (entry.stat.isDirectory()) {
        for (const name of await fs.readdir(entry.path)) await visit(path.join(entry.path, name));
      } else { bytes += entry.stat.size; if (copying && bytes > MAX_COPY_BYTES) throw new Error(t("复制内容超过 256 MiB，请在系统文件管理器中操作。")); }
    };
    await visit(source);
  }

  async operate(input, trash) {
    if (!input || typeof input !== 'object') throw new TypeError(t("无效的文件操作。"));
    const { action } = input;
    if (action === 'create-file' || action === 'create-folder') {
      const name = allowedName(input.name);
      if (action === 'create-file' && !isDocumentPath(name)) throw new Error(t("文稿名称需要 Markdown 或 .txt 扩展名。"));
      const target = await this.target(input.path, name);
      if (action === 'create-folder') await fs.mkdir(target);
      else { const handle = await fs.open(target, 'wx', 0o600); await handle.close(); }
      return { action, previousPath: null, path: target };
    }
    if (!['rename', 'copy', 'move', 'trash'].includes(action)) throw new TypeError(t("无效的文件操作。"));
    const source = await this.existing(input.path);
    if (source.stat.isFile() && !isDocumentPath(source.path)) throw new Error(t("文件操作仅支持 Markdown 或文本文件。"));
    await this.inspectTree(source.path, action === 'copy');
    if (action === 'trash') {
      if (typeof trash !== 'function') throw new Error(t("系统回收站不可用，文件未删除。"));
      await this.existing(source.path);
      await trash(source.path);
      return { action, previousPath: source.path, path: null };
    }
    const name = input.name || path.basename(source.path);
    if (source.stat.isFile() && !isDocumentPath(name)) throw new Error(t("保留 Markdown 或 .txt 扩展名。"));
    const parent = action === 'rename' ? path.dirname(source.path) : input.destination;
    const target = await this.target(parent, name);
    if (source.stat.isDirectory() && isWithin(target, source.path)) throw new Error(t("不能把文件夹放入它自己的子目录。"));
    await this.existing(source.path);
    if (action === 'copy') {
      // Every destination is exclusive. A failed directory copy leaves its partial copy visible, never removes user data.
      const copy = async (from, to) => {
        const entry = await this.existing(from);
        if (entry.stat.isDirectory()) {
          await fs.mkdir(to);
          for (const child of await fs.readdir(from)) await copy(path.join(from, child), path.join(to, child));
        } else await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      };
      try { await copy(source.path, target); }
      catch (error) { throw new Error(t("复制未完成，原文件仍在，目标可能保留部分副本：{0}", error.message)); }
    } else {
      await this.target(parent, name);
      if (source.stat.isFile()) {
        // rename() replaces existing files on POSIX and Windows. A hard link creates the target exclusively.
        // Unsupported/cross-volume links fail without touching the source; never fall back to an overwrite.
        try { await fs.link(source.path, target); }
        catch (error) { throw new Error(t("无法安全移动文件，原文件未删除（目标可能已存在，或文件系统不支持同卷硬链接）：{0}", error.message)); }
        try {
          const latest = (await this.existing(source.path)).stat;
          if (latest.ino !== source.stat.ino || latest.dev !== source.stat.dev) throw new Error(t("源文件已被其他程序替换"));
          await fs.unlink(source.path);
        } catch (error) { throw new Error(t("目标副本已保留，但原位置未移除，请检查两个位置：{0}", error.message)); }
      } else if (process.platform === 'win32') {
        // Windows directory rename refuses an occupied destination, including an empty directory.
        await fs.rename(source.path, target);
      } else {
        // POSIX may replace an empty directory. Reserve its name atomically before replacing OUR empty directory.
        // New content makes rename fail; a third party deliberately deleting/replacing the reservation is detected
        // by identity checks. Node has no portable renameat2(RENAME_NOREPLACE) for the final syscall-sized interval.
        await fs.mkdir(target);
        const reservation = await fs.lstat(target);
        try {
          const checked = await this.existing(target);
          if (checked.stat.ino !== reservation.ino || checked.stat.dev !== reservation.dev) throw new Error(t("目标目录已被其他程序替换"));
          await fs.rename(source.path, target);
        } catch (error) {
          const leftover = await fs.lstat(target).catch(() => null);
          if (leftover?.ino === reservation.ino && leftover?.dev === reservation.dev) await fs.rmdir(target).catch(() => {});
          throw error;
        }
      }
    }
    return { action, previousPath: source.path, path: target };
  }

  async search(query, caseSensitive = false) {
    if (typeof query !== 'string' || !query.trim() || query.length > 256 || typeof caseSensitive !== 'boolean') throw new TypeError(t("搜索文字应为 1–256 个字符。"));
    const snapshot = await this.snapshot();
    const matches = [];
    let scanned = 0, skipped = 0, bytes = 0, truncated = snapshot.truncated;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    for (const entry of snapshot.entries) {
      if (matches.length >= 200 || bytes >= MAX_SEARCH_BYTES) { truncated = true; break; }
      try {
        const safe = await this.existing(entry.path, { document: true });
        if (safe.stat.size > MAX_DOCUMENT_BYTES || bytes + safe.stat.size > MAX_SEARCH_BYTES) { skipped++; truncated = true; continue; }
        const buffer = await fs.readFile(safe.path); bytes += buffer.length;
        if (buffer.length > MAX_DOCUMENT_BYTES) { skipped++; continue; }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (content.includes('\0')) { skipped++; continue; }
        scanned++;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const found = (caseSensitive ? lines[index] : lines[index].toLocaleLowerCase()).indexOf(needle);
          if (found < 0) continue;
          matches.push({ path: entry.path, name: entry.name, relativePath: entry.relativePath, line: index + 1, column: found + 1, text: lines[index].slice(Math.max(0, found - 55), found + query.length + 150) });
          if (matches.length >= 200) { truncated = true; break; }
        }
      } catch { skipped++; }
    }
    return { matches, scanned, skipped, truncated };
  }

  async resolveLink(href, documentPath) {
    if (typeof href !== 'string' || !href || href.length > 8192 || /[\x00-\x1f]/.test(href)) throw new TypeError(t("无效的 Markdown 链接。"));
    await this.existing(documentPath, { document: true });
    const hash = href.indexOf('#');
    const part = hash < 0 ? href : href.slice(0, hash);
    let file, anchor;
    try { file = decodeURIComponent(part); anchor = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)); } catch { throw new Error(t("链接包含无效的 URL 编码。")); }
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) || /^[\\/]/.test(file) || file.includes('?')) throw new Error(t("仅在Meki中打开工作区内的相对 Markdown 链接。"));
    let target = part ? path.resolve(path.dirname(documentPath), file) : documentPath;
    if (!path.extname(target)) {
      for (const ext of ['.md', '.markdown']) {
        try { await fs.lstat(target + ext); target += ext; break; } catch { /* Try next Markdown extension. */ }
      }
    }
    const resolved = await this.existing(target, { document: true });
    return { path: resolved.path, anchor };
  }
}

async function documentStatus(filePath, revision) {
  validateAbsolutePath(filePath);
  if (revision !== null && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) throw new TypeError(t("无效的文件版本。"));
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return { state: 'changed', revision: null };
    const hash = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
    return { state: hash === revision ? 'unchanged' : 'changed', revision: hash };
  } catch (error) { if (error.code === 'ENOENT') return { state: 'missing', revision: null }; throw error; }
}

module.exports = { WorkspaceStore, documentStatus, allowedName };

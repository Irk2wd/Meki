'use strict';
const { t, isLocale } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { fileURLToPath } = require('node:url');
const { MAX_IMAGE_COUNT, MAX_BATCH_BYTES } = require('./image-input.cjs');
const { normalizeDestinationSettings, resolveImageDestination, ensureImageDestination, rollbackImageDirectories } = require('./image-destination.cjs');
const { validateBindings } = require('./shortcuts.mjs');

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_THEME_BYTES = 256 * 1024;
// JSON escaping may expand one CSS byte to six bytes; leave room for existing metadata.
const MAX_METADATA_BYTES = MAX_THEME_BYTES * 6 + 256 * 1024;
const MAX_WORKSPACE_ENTRIES = 500;
const MAX_RECENT_FOLDERS = 20;
const MAX_PINNED_FOLDERS = 10;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.txt']);
const DEFAULT_SETTINGS = Object.freeze({
  locale: 'zh-CN',
  shortcuts: Object.freeze({}),
  theme: 'paper', font: 'serif', fontSize: 18, lineWidth: 760, focus: false, sidebar: true,
  customCss: '', fontFamily: '', mathNumbering: 'none', mathPhysics: false,
  typewriter: false, paragraphFocus: false, spellcheck: false,
  typingAutoPair: 'default', typingMarkdownPairs: false, typingSmartQuotes: false, typingSmartDashes: false,
  autoSave: false, autoSaveInterval: 30, reopenSession: true,
  autoSaveOnBlur: true, autoSnapshot: true, snapshotInterval: 60,
  codeLineNumbers: true,
  headingNumbering: false,
  codeWrap: false, codeIndentSize: 2, codeUseTabs: false, codeTabSize: 4,
  codeAutoIndent: true, codeLanguageMode: 'plain', codeDefaultLanguage: '', codeLastLanguage: '',
  picgoPort: 36677, imageAutoUpload: false,
  imageDirectoryBase: 'document', imageDirectory: '${filename}.assets',
});
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
});
const SKIP_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', '.meki', '.next', '.cache', '$RECYCLE.BIN', 'System Volume Information']);

class RevisionConflictError extends Error {
  constructor(filePath) {
    super('The file changed outside Meki. Choose how to save your edits.');
    this.name = 'RevisionConflictError';
    this.code = 'REVISION_CONFLICT';
    this.path = filePath;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAbsolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 32767 || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) {
    throw new TypeError('A valid absolute file path is required.');
  }
  return path.normalize(value);
}

function pathKey(value) {
  const normalized = validateAbsolutePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(filePath, root) {
  const relative = path.relative(pathKey(root), pathKey(filePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isDocumentPath(value) {
  return typeof value === 'string' && DOCUMENT_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function validateText(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_BYTES || value.includes('\0')) {
    throw new TypeError('Markdown must be UTF-8 text smaller than 16 MB, without NUL characters.');
  }
  return value;
}

function validateDocument(value, { requirePath = false } = {}) {
  if (!isObject(value)) throw new TypeError('A document is required.');
  const filePath = value.path === null && !requirePath ? null : validateAbsolutePath(value.path);
  if (filePath && !isDocumentPath(filePath)) throw new TypeError('Choose a Markdown or text file.');
  if (typeof value.name !== 'string' || value.name.length > 512) throw new TypeError('Invalid document name.');
  if (value.revision !== null && (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision))) {
    throw new TypeError('Invalid document revision.');
  }
  return { path: filePath, name: filePath ? path.basename(filePath) : (value.name || t("未命名.md")), content: validateText(value.content), revision: value.revision };
}

function validateSettings(patch, base = DEFAULT_SETTINGS) {
  if (!isObject(patch)) throw new TypeError('Settings must be an object.');
  const next = { ...DEFAULT_SETTINGS, ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (key === 'shortcuts') { next.shortcuts = validateBindings(value, process.platform); continue; }
    const valid = key === 'locale' ? isLocale(value)
      : key === 'theme' ? ['paper', 'linen', 'night'].includes(value)
      : key === 'font' ? ['serif', 'sans'].includes(value)
      : key === 'fontSize' ? Number.isFinite(value) && value >= 12 && value <= 32
      : key === 'lineWidth' ? Number.isFinite(value) && value >= 480 && value <= 1200
      : key === 'customCss' ? typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_THEME_BYTES && !value.includes('\0')
      : key === 'fontFamily' ? typeof value === 'string' && value.length <= 128 && /^[\p{L}\p{M}\p{N} ._-]*$/u.test(value)
      : key === 'mathNumbering' ? ['none', 'ams', 'all'].includes(value)
      : key === 'typingAutoPair' ? ['default', 'on', 'off'].includes(value)
      : ['typingMarkdownPairs', 'typingSmartQuotes', 'typingSmartDashes'].includes(key) ? typeof value === 'boolean'
      : key === 'autoSaveInterval' ? Number.isInteger(value) && value >= 2 && value <= 600
      : key === 'snapshotInterval' ? Number.isInteger(value) && value >= 10 && value <= 600
      : ['autoSaveOnBlur', 'autoSnapshot'].includes(key) ? typeof value === 'boolean'
      : key === 'picgoPort' ? Number.isInteger(value) && value >= 1 && value <= 65535
      : key === 'imageAutoUpload' ? typeof value === 'boolean'
      : key === 'imageDirectoryBase' ? ['document', 'workspace'].includes(value)
      : key === 'imageDirectory' ? typeof value === 'string' && Boolean(normalizeDestinationSettings({ directory: value }))
      : key === 'codeLanguageMode' ? ['plain', 'default', 'last'].includes(value)
      : ['codeDefaultLanguage', 'codeLastLanguage'].includes(key) ? typeof value === 'string' && /^[a-zA-Z0-9_+.#-]{0,40}$/.test(value)
      : ['codeIndentSize', 'codeTabSize'].includes(key) ? Number.isInteger(value) && value >= 1 && value <= 8
      : ['focus', 'sidebar', 'mathPhysics', 'typewriter', 'paragraphFocus', 'spellcheck', 'autoSave', 'reopenSession', 'codeLineNumbers', 'headingNumbering', 'codeWrap', 'codeUseTabs', 'codeAutoIndent'].includes(key) ? typeof value === 'boolean' : false;
    if (!valid) throw new TypeError(`Invalid setting: ${key}`);
    // fontFamily is a single local font name, never CSS syntax or a fallback list.
    next[key] = key === 'fontFamily' ? value.trim() : value;
  }
  return next;
}

function restoreSettings(input) {
  let settings = { ...DEFAULT_SETTINGS };
  if (!isObject(input)) return settings;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(input, key)) continue;
    try { settings = validateSettings({ [key]: input[key] }, settings); }
    catch { /* Preserve valid old preferences when an individual stored value is invalid. */ }
  }
  return settings;
}

function restoreRecentFolders(input) {
  const seen = new Set(); let pinned = 0;
  const folders = [];
  if (!Array.isArray(input)) return folders;
  for (const value of input.slice(0, 100)) {
    try {
      const folder = validateAbsolutePath(value.path), key = pathKey(folder);
      if (seen.has(key)) continue;
      seen.add(key);
      const pin = value.pinned === true && pinned < MAX_PINNED_FOLDERS;
      if (pin) pinned++;
      folders.push({ path: folder, name: path.basename(folder) || folder, pinned: pin,
        lastOpened: Number.isSafeInteger(value.lastOpened) && value.lastOpened >= 0 ? value.lastOpened : 0 });
    } catch { /* Keep other valid records; existence is checked only when explicitly opened. */ }
  }
  let bytes = 0;
  return folders.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpened - a.lastOpened).slice(0, MAX_RECENT_FOLDERS).filter(folder => {
    const size = Buffer.byteLength(JSON.stringify(folder), 'utf8');
    if (bytes + size > 128 * 1024) return false;
    bytes += size; return true;
  });
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeDocument(bytes) {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('This file exceeds the 16 MB editing limit.');
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    throw new Error('This file is not UTF-8. Convert it to UTF-8 before opening it in Meki.');
  }
  if (text.includes('\0')) throw new Error('This file contains binary data and cannot be opened as Markdown.');
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.match(/(?<!\r)\n/g) || []).length;
  return { content: text.replace(/\r\n/g, '\n'), bom, newline: crlfCount > lfCount ? '\r\n' : '\n', bytes };
}

async function readBytes(filePath, maxBytes = MAX_DOCUMENT_BYTES) {
  const handle = await fs.open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('The selected path is not a regular file.');
    if (info.size > maxBytes) {
      const limit = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${Math.round(maxBytes / 1024)} KiB`;
      throw new Error(`The selected file exceeds the ${limit} size limit.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error('The selected file became too large to read.');
    return { bytes, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath, bytes, options = {}) {
  filePath = validateAbsolutePath(filePath);
  const temporary = path.join(path.dirname(filePath), `.meki-${process.pid}-${crypto.randomBytes(10).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', options.mode ?? 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // A same-directory rename replaces the complete file atomically. Never unlink the original as a fallback.
    for (let attempt = 0; ; attempt++) {
      // A Windows reader or indexer can briefly lock the destination. Recheck conflicts after every wait.
      if (options.beforeCommit) await options.beforeCommit();
      try { await fs.rename(temporary, filePath); break; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 100)));
      }
    }
    if (process.platform !== 'win32') {
      let directory;
      try { directory = await fs.open(path.dirname(filePath), 'r'); await directory.sync(); }
      catch { /* Some filesystems do not support directory fsync; the file itself is already synced. */ }
      finally { if (directory) await directory.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function encodeRelativePath(value) {
  return value.split(path.sep).map((part) => encodeURIComponent(part).replace(/[()']/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function imageType(bytes, extension) {
  const mime = IMAGE_TYPES[extension];
  if (!mime || bytes.length === 0) return null;
  if (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return mime;
  if (['.jpg', '.jpeg'].includes(extension) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return mime;
  if (extension === '.gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return mime;
  if (extension === '.webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return mime;
  if (extension === '.avif' && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 40).toString('ascii'))) return mime;
  if (extension === '.bmp' && bytes.subarray(0, 2).toString('ascii') === 'BM') return mime;
  if (extension === '.ico' && bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return mime;
  if (extension === '.svg' && /<svg(?:\s|>)/i.test(bytes.subarray(0, 4096).toString('utf8'))) return mime;
  return null;
}

class FileStore {
  constructor(userData) {
    this.userData = validateAbsolutePath(userData);
    this.statePath = path.join(this.userData, 'state.json');
    this.draftPath = path.join(this.userData, 'recovery.json');
    this.formats = new Map();
    this.locks = new Map();
    this.metadata = { settings: { ...DEFAULT_SETTINGS }, recentFiles: [], recentFolders: [], workspaceRoot: null, windowBounds: null };
  }

  async locked(key, action) {
    const previous = this.locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.locks.set(key, operation);
    try { return await operation; }
    finally { if (this.locks.get(key) === operation) this.locks.delete(key); }
  }

  async init() {
    await fs.mkdir(this.userData, { recursive: true });
    try {
      const { bytes } = await readBytes(this.statePath, MAX_METADATA_BYTES);
      const state = JSON.parse(bytes.toString('utf8'));
      if (isObject(state)) {
        this.metadata.settings = restoreSettings(state.settings);
        if (Array.isArray(state.recentFiles)) {
          this.metadata.recentFiles = state.recentFiles.slice(0, 24).flatMap((entry) => {
            try {
              const filePath = validateAbsolutePath(entry.path);
              return isDocumentPath(filePath) ? [{ path: filePath, name: path.basename(filePath) }] : [];
            } catch { return []; }
          });
        }
        try { if (state.workspaceRoot) this.metadata.workspaceRoot = validateAbsolutePath(state.workspaceRoot); } catch { /* Ignore invalid storage. */ }
        this.metadata.recentFolders = restoreRecentFolders(state.recentFolders);
        if (isObject(state.windowBounds) && ['width', 'height'].every((key) => Number.isFinite(state.windowBounds[key]))) {
          const saved = state.windowBounds;
          this.metadata.windowBounds = {
            width: Math.min(3840, Math.max(760, saved.width)), height: Math.min(2160, Math.max(540, saved.height)),
            ...(Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
            maximized: saved.maximized === true,
          };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Meki ignored invalid saved settings:', error.message);
    }
    return this.metadata;
  }

  async updateMetadata(patch) {
    return this.locked('metadata', async () => {
      const next = { ...this.metadata, ...patch };
      next.settings = validateSettings(next.settings);
      await atomicWrite(this.statePath, Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
      this.metadata = next;
      return this.metadata;
    });
  }

  async updateSettings(patch) {
    // Merge after earlier writes finish so rapid controls cannot erase one another's settings.
    validateSettings(patch);
    return this.locked('metadata', async () => {
      const settings = validateSettings(patch, this.metadata.settings);
      const next = { ...this.metadata, settings };
      await atomicWrite(this.statePath, Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
      this.metadata = next;
      return settings;
    });
  }

  async changeRecentFolders(action, folder) {
    if (!['remember', 'pin', 'unpin', 'remove', 'clear'].includes(action)) throw new TypeError(t("无效的最近文件夹操作。"));
    if (action === 'clear') { if (folder !== undefined) throw new TypeError(t("清空记录不接受路径。")); }
    else folder = validateAbsolutePath(folder);
    return this.locked('metadata', async () => {
      let folders = this.metadata.recentFolders.map(entry => ({ ...entry }));
      const previous = folder && folders.find(entry => pathKey(entry.path) === pathKey(folder));
      if (action !== 'remember' && action !== 'clear' && !previous) throw new Error(t("该文件夹不在最近记录中，请通过“打开文件夹”选择。"));
      if (action === 'remember') {
        const lastOpened = Math.max(Date.now(), ...folders.map(entry => entry.lastOpened + 1));
        folders = [{ path: folder, name: path.basename(folder) || folder, pinned: previous?.pinned || false, lastOpened }, ...folders.filter(entry => entry !== previous)];
      } else if (action === 'pin') {
        if (!previous.pinned && folders.filter(entry => entry.pinned).length >= MAX_PINNED_FOLDERS) throw new Error(t("最多固定 10 个文件夹，请先取消固定一项。"));
        previous.pinned = true;
      } else if (action === 'unpin') previous.pinned = false;
      else if (action === 'remove') folders = folders.filter(entry => entry !== previous);
      else folders = folders.filter(entry => entry.pinned);
      const next = { ...this.metadata, recentFolders: restoreRecentFolders(folders), ...(action === 'remember' ? { workspaceRoot: folder } : {}) };
      await atomicWrite(this.statePath, Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
      this.metadata = next;
      return next.recentFolders;
    });
  }

  async readTheme(filePath) {
    filePath = validateAbsolutePath(filePath);
    if (path.extname(filePath).toLowerCase() !== '.css') throw new TypeError('Choose a CSS theme file.');
    const { bytes } = await readBytes(filePath, MAX_THEME_BYTES);
    let css;
    try { css = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('This theme is not UTF-8. Convert it to UTF-8 before importing it.'); }
    validateSettings({ customCss: css });
    // Import only reads the selected text. The renderer scopes and sanitizes it before use.
    return { name: path.basename(filePath), css };
  }

  async readDocument(filePath) {
    filePath = validateAbsolutePath(filePath);
    if (!isDocumentPath(filePath)) throw new TypeError('Choose a Markdown or text file.');
    filePath = await fs.realpath(filePath);
    if (!isDocumentPath(filePath)) throw new TypeError('The linked target must be a Markdown or text file.');
    const { bytes } = await readBytes(filePath);
    const format = decodeDocument(bytes);
    this.formats.set(pathKey(filePath), { bom: format.bom, newline: format.newline });
    return { path: filePath, name: path.basename(filePath), content: format.content, revision: digest(bytes) };
  }

  async saveDocument(input, options = {}) {
    const document = validateDocument(input, { requirePath: true });
    try {
      // Follow an explicitly selected symlink instead of replacing the link during the atomic rename.
      document.path = await fs.realpath(document.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const entry = await fs.lstat(document.path).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; return null; });
      if (entry?.isSymbolicLink()) throw new Error('The selected symbolic link has no target. Choose a different save path.');
      document.path = path.join(await fs.realpath(path.dirname(document.path)), path.basename(document.path));
    }
    document.name = path.basename(document.path);
    if (!isDocumentPath(document.path)) throw new TypeError('The linked target must be a Markdown or text file.');
    let sourceFormatKey = options.formatFrom ? pathKey(options.formatFrom) : pathKey(document.path);
    if (options.formatFrom && !this.formats.has(sourceFormatKey)) {
      try { sourceFormatKey = pathKey(await fs.realpath(options.formatFrom)); } catch { /* The original may have been moved or deleted. */ }
    }
    return this.locked(`document:${pathKey(document.path)}`, async () => {
      let existing = null;
      try { existing = await readBytes(document.path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const existingRevision = existing ? digest(existing.bytes) : null;
      if (!options.overwrite && document.revision !== existingRevision) throw new RevisionConflictError(document.path);
      let previousFormat = null;
      if (existing) {
        try { previousFormat = decodeDocument(existing.bytes); }
        catch (error) { if (!options.overwrite) throw error; }
      }
      const cachedFormat = this.formats.get(sourceFormatKey);
      const format = cachedFormat || previousFormat || { bom: false, newline: '\n' };
      const normalized = document.content.replace(/\r\n/g, '\n');
      const encodedText = format.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
      const bytes = previousFormat && normalized === previousFormat.content ? existing.bytes
        : Buffer.concat([format.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(encodedText, 'utf8')]);
      if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('The encoded document exceeds the 16 MB size limit.');
      await atomicWrite(document.path, bytes, {
        mode: existing?.mode,
        beforeCommit: async () => {
          let currentRevision = null;
          try { currentRevision = digest((await readBytes(document.path)).bytes); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          // Even after an explicit overwrite decision, do not erase a *subsequent* external edit.
          if (currentRevision !== existingRevision) throw new RevisionConflictError(document.path);
          if (existing && !bytes.equals(existing.bytes) && options.beforeReplace) {
            await options.beforeReplace(document.path, existing.bytes);
            // History I/O is asynchronous: recheck after recording the previous bytes as well.
            const checked = await readBytes(document.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
            if ((checked ? digest(checked.bytes) : null) !== existingRevision) throw new RevisionConflictError(document.path);
          }
        },
      });
      this.formats.set(pathKey(document.path), { bom: format.bom, newline: format.newline });
      return { path: document.path, name: path.basename(document.path), content: normalized, revision: digest(bytes) };
    });
  }

  async loadDraft() {
    try {
      const { bytes } = await readBytes(this.draftPath, MAX_DOCUMENT_BYTES * 6 + 64 * 1024);
      const input = JSON.parse(bytes.toString('utf8'));
      const document = validateDocument(input);
      if (!Number.isFinite(input.updatedAt) || input.updatedAt <= 0) return null;
      return { ...document, updatedAt: input.updatedAt };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Meki could not read its recovery draft:', error.message);
      return null;
    }
  }

  async saveDraft(input) {
    const draft = input === null ? null : { ...validateDocument(input), updatedAt: input.updatedAt };
    if (draft && (!Number.isFinite(draft.updatedAt) || draft.updatedAt <= 0)) throw new TypeError('Invalid draft timestamp.');
    return this.locked('draft', async () => {
      if (draft === null) {
        await fs.unlink(this.draftPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      } else {
        await atomicWrite(this.draftPath, Buffer.from(JSON.stringify(draft), 'utf8'));
      }
    });
  }

  async readWorkspace(root, limit = MAX_WORKSPACE_ENTRIES) {
    root = validateAbsolutePath(root);
    const rootInfo = await fs.stat(root);
    if (!rootInfo.isDirectory()) throw new Error('Choose a folder.');
    const entries = [];
    let visited = 0;
    let truncated = false;
    const visit = async (directory) => {
      if (entries.length >= limit || visited >= 5000) { truncated = true; return; }
      visited += 1;
      let items;
      try { items = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (directory === root) throw error; return; }
      items.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const item of items) {
        if (entries.length >= limit || visited >= 5000) { truncated = true; return; }
        const itemPath = path.join(directory, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory() && !SKIP_DIRECTORIES.has(item.name) && !item.name.endsWith('.assets')) await visit(itemPath);
        else if (item.isFile() && isDocumentPath(item.name)) {
          entries.push({ path: itemPath, name: item.name, relativePath: path.relative(root, itemPath).split(path.sep).join('/') });
        }
      }
    };
    await visit(root);
    return { root, entries, truncated };
  }

  async saveAttachment({ bytes, name, documentPath }, workspaceRoot = null) {
    return (await this.saveAttachments({ images: [{ bytes, name }], documentPath }, workspaceRoot))[0];
  }

  async saveAttachments({ images, documentPath }, workspaceRoot = null) {
    documentPath = validateAbsolutePath(documentPath);
    if (!isDocumentPath(documentPath)) throw new TypeError('Save the Markdown document first.');
    const info = await fs.stat(documentPath);
    if (!info.isFile()) throw new Error('Save the Markdown document first.');
    if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGE_COUNT) throw new TypeError(t("一次可添加 1–32 张图片。"));
    let total = 0;
    const prepared = images.map(image => {
      const { bytes, name } = image || {};
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new TypeError('Choose an image smaller than 20 MB.');
      total += bytes.byteLength; if (total > MAX_BATCH_BYTES) throw new TypeError(t("每批图片不超过 80 MiB。"));
      if (typeof name !== 'string' || name.length > 1024) throw new TypeError('Invalid attachment name.');
      const inputName = name.split(/[\\/]/).pop(), extension = path.extname(inputName).toLowerCase(), buffer = Buffer.from(bytes);
      if (!imageType(buffer, extension)) throw new Error('Use a valid PNG, JPEG, GIF, WebP, AVIF, BMP, ICO or SVG image.');
      const stem = path.parse(inputName).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'image';
      return { buffer, outputName: `${stem}-${crypto.randomBytes(5).toString('hex')}${extension}` };
    });
    const destination = await resolveImageDestination({ documentPath, workspaceRoot, base: this.metadata.settings.imageDirectoryBase, directory: this.metadata.settings.imageDirectory });
    const ready = await ensureImageDestination(destination), assetsDirectory = ready.target, targetStat = await fs.lstat(ready.target);
    const checkTarget = async () => {
      await resolveImageDestination({ documentPath, workspaceRoot, boundaryRoot: ready.root, ...ready.settings });
      const stat = await fs.lstat(assetsDirectory);
      if (stat.dev !== targetStat.dev || stat.ino !== targetStat.ino) throw new Error(t("图片目录在保存期间已变化。"));
    };
    const written = [];
    try {
      for (const { buffer, outputName } of prepared) {
        await checkTarget();
        const outputPath = path.join(assetsDirectory, outputName), handle = await fs.open(outputPath, 'wx', 0o600);
        const record = { path: outputPath, stat: await handle.stat(), hash: digest(buffer) }; written.push(record);
        let count = 0;
        try {
          while (count < buffer.length) {
            const result = await handle.write(buffer, count, buffer.length - count, count);
            if (!result.bytesWritten) throw new Error(t("图片未能完整写入磁盘。"));
            count += result.bytesWritten;
          }
          await handle.sync();
        } catch (error) { record.hash = digest(buffer.subarray(0, count)); throw error; }
        finally { await handle.close(); }
        await checkTarget();
        const stat = await fs.lstat(outputPath);
        if (stat.isSymbolicLink() || stat.dev !== record.stat.dev || stat.ino !== record.stat.ino) throw new Error(t("图片在保存期间已变化。"));
      }
      return prepared.map(({ outputName }) => encodeRelativePath(path.relative(path.dirname(documentPath), path.join(assetsDirectory, outputName))));
    } catch (error) {
      for (const record of written) {
        try {
          await checkTarget();
          const stat = await fs.lstat(record.path);
          if (!stat.isSymbolicLink() && stat.dev === record.stat.dev && stat.ino === record.stat.ino && digest((await readBytes(record.path, MAX_IMAGE_BYTES)).bytes) === record.hash) await fs.unlink(record.path);
        } catch { /* Keep externally replaced or modified files. */ }
      }
      await rollbackImageDirectories(ready.created, ready.root);
      throw error;
    }
  }

  async assetUrl(source, documentPath, workspaceRoot = null) {
    if (typeof source !== 'string' || source.length > MAX_IMAGE_BYTES * 1.5) throw new TypeError('Invalid image source.');
    if (/^https?:\/\//i.test(source)) return source;
    if (/^data:image\//i.test(source)) return source;
    if (!documentPath || source.includes('\0')) return source;
    try {
      documentPath = validateAbsolutePath(documentPath);
      let decoded = /^file:/i.test(source) ? fileURLToPath(source) : decodeURIComponent(source.split(/[?#]/, 1)[0]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !path.isAbsolute(decoded)) return source;
      const candidate = path.resolve(path.dirname(documentPath), decoded);
      const allowedRoot = workspaceRoot && isWithin(documentPath, workspaceRoot) ? workspaceRoot : path.dirname(documentPath);
      const [actualFile, actualRoot] = await Promise.all([fs.realpath(candidate), fs.realpath(allowedRoot)]);
      if (!isWithin(actualFile, actualRoot)) return source;
      const extension = path.extname(actualFile).toLowerCase();
      if (!IMAGE_TYPES[extension]) return source;
      const { bytes } = await readBytes(actualFile, MAX_IMAGE_BYTES);
      const mime = imageType(bytes, extension);
      return mime ? `data:${mime};base64,${bytes.toString('base64')}` : source;
    } catch { return source; }
  }
}

module.exports = {
  FileStore, RevisionConflictError, DEFAULT_SETTINGS, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, MAX_THEME_BYTES,
  MAX_WORKSPACE_ENTRIES, DOCUMENT_EXTENSIONS, validateAbsolutePath, validateDocument,
  validateSettings, pathKey, isWithin, isDocumentPath, atomicWrite, readBytes, decodeDocument, digest,
  restoreRecentFolders, MAX_RECENT_FOLDERS, MAX_PINNED_FOLDERS, imageType, encodeRelativePath,
};

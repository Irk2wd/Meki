'use strict';
const { t } = require('./i18n.mjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { atomicWrite, validateAbsolutePath, isWithin } = require('./file-store.cjs');
const { validateDocx } = require('./docx-template.cjs');
const { prepareWordMath } = require('./word-math.cjs');
const MAX = 96 * 1024 * 1024;
const MINIMUM_VERSION = '3.12.1';
function supportedVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
  const actual = version.split('.').map(Number), required = MINIMUM_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index++) { if ((actual[index] || 0) !== required[index]) return (actual[index] || 0) > required[index]; }
  return true;
}

function run(executable, args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { cwd, windowsHide: true, timeout: 45_000, maxBuffer: MAX, encoding: 'buffer', shell: false }, (error, stdout, stderr) => {
      if (error) reject(new Error(t("Pandoc 转换失败：{0}", stderr?.toString('utf8').slice(0, 2000) || error.message)));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
  });
}
function imageData(value) {
  if (typeof value !== 'string' || value.length > 28 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\r\n]+$/i.test(value)) return false;
  const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  return bytes.length > 8 && (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes[0] === 255 && bytes[1] === 216 || /^GIF8[79]a/.test(bytes.toString('ascii',0,6)) || bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP');
}
async function cleanAst(ast, imageResolver) {
  const warnings = [];
  async function visit(value) {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== 'object') return value;
    if (value.t === 'RawBlock') return { t: 'CodeBlock', c: [['', [], []], String(value.c[1])] };
    if (value.t === 'RawInline') return { t: 'Code', c: [['', [], []], String(value.c[1])] };
    if (value.t === 'Image') {
      const original = value.c[2][0]; const data = await imageResolver(original);
      if (!data || !imageData(data)) {
        warnings.push(t("未读取外部或不支持的图片，文稿中保留了说明。"));
        return { t: 'Span', c: [['', [], []], [{ t: 'Str', c: t("[未导入图片：{0}]", String(original).slice(0, 180)) }]] };
      }
      return { t: 'Image', c: [value.c[0], await visit(value.c[1]), [data, value.c[2][1] || '']] };
    }
    if (value.t === 'Link' && !/^(?:https?:|mailto:|#)/i.test(value.c[2][0])) return { t: 'Span', c: [['', [], []], await visit(value.c[1])] };
    const out = {}; for (const [key, child] of Object.entries(value)) out[key] = await visit(child); return out;
  }
  return { ast: { ...ast, meta: {}, blocks: await visit(ast.blocks) }, warnings: [...new Set(warnings)] };
}
class PandocService {
  constructor(userData) { this.config = path.join(userData, 'export-tools.json'); }
  async executable() {
    if (process.env.MOYE_PANDOC_PATH) return validateAbsolutePath(process.env.MOYE_PANDOC_PATH);
    try { const saved = JSON.parse(await fs.readFile(this.config, 'utf8')); if (saved.path) return validateAbsolutePath(saved.path); } catch {}
    for (const folder of [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
      const file = path.join(folder, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
      if (await fs.stat(file).then(info => info.isFile()).catch(() => false)) return path.resolve(file);
    }
    return null;
  }
  async status() {
    const executable = await this.executable();
    if (!executable) return { available: false, message: t("未找到 Pandoc。DOCX / EPUB 导出与 Word / HTML 导入需要本机 Pandoc {0} 或更新版本。", MINIMUM_VERSION) };
    try {
      const output = (await run(executable, ['--version'], '', path.dirname(executable))).toString('utf8');
      const version = output.match(/^pandoc\s+(\d+\.\d+(?:\.\d+)?)/m)?.[1];
      if (!supportedVersion(version)) return { available: false, path: executable, version, message: t("检测到 {0}；请选择 Pandoc {1} 或更新版本以使用受控转换。", version || t("未知版本"), MINIMUM_VERSION) };
      return { available: true, path: executable, version, message: t("Pandoc {0} · 本机受控转换", version) };
    } catch (error) { return { available: false, path: executable, message: String(error).slice(0, 500) }; }
  }
  async setExecutable(file) {
    file = await fs.realpath(validateAbsolutePath(file));
    if (!/^pandoc(?:\.exe)?$/i.test(path.basename(file))) throw new Error(t("请选择名为 pandoc 或 pandoc.exe 的程序。"));
    const version = (await run(file, ['--version'], '', path.dirname(file))).toString().match(/^pandoc\s+(\d+\.\d+(?:\.\d+)?)/m)?.[1];
    if (!supportedVersion(version)) throw new Error(t("需要 Pandoc {0} 或更新版本。", MINIMUM_VERSION));
    await atomicWrite(this.config, Buffer.from(JSON.stringify({ path: file })));
    return { available: true, path: file, version, message: t("Pandoc {0} · 本机受控转换", version) };
  }
  async temporary(action) {
    const status = await this.status(); if (!status.available) throw new Error(status.message);
    // Windows TEMP may use an 8.3 alias; use one canonical root for containment checks.
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const folder = await fs.mkdtemp(path.join(temporaryRoot, 'moye-pandoc-'));
    const args = ['--sandbox', `--data-dir=${folder}`, '+RTS', '-M512M', '-RTS'];
    try { return await action(folder, (more, input) => run(status.path, [...args, ...more], input, folder)); }
    finally {
      if (path.dirname(folder) !== temporaryRoot || !path.basename(folder).startsWith('moye-pandoc-')) throw new Error('Invalid conversion temporary directory');
      await fs.rm(folder, { recursive: true, force: true });
    }
  }
  async exportDocument(html, kind, title, referenceBytes = null) {
    this.lastMathExport = null;
    if (!['docx','epub'].includes(kind) || typeof html !== 'string' || Buffer.byteLength(html) > MAX) throw new TypeError(t("转换内容不正确。"));
    let reference = null;
    if (referenceBytes !== null) {
      if (kind !== 'docx' || !Buffer.isBuffer(referenceBytes)) throw new TypeError(t("Word 样式模板需为已经验证的 DOCX 内容。"));
      reference = Buffer.from(referenceBytes); validateDocx(reference);
    }
    return this.temporary(async (folder, execute) => {
      const referencePath = reference ? path.join(folder, 'approved-reference.docx') : null;
      if (reference) await fs.writeFile(referencePath, reference, { flag: 'wx', mode: 0o600 });
      const ast = JSON.parse((await execute(['--from=html+raw_html', '--to=json', '--fail-if-warnings'], html)).toString('utf8'));
      const safe = await cleanAst(ast, value => Promise.resolve(imageData(value) ? value : null));
      if (safe.warnings.length) throw new Error(t("导出中含未嵌入的图片。请使用本地图片，或先移除无法读取的外部图片。"));
      if (kind === 'docx') this.lastMathExport = await prepareWordMath(safe.ast, execute, folder);
      safe.ast.meta = { title: { t: 'MetaString', c: title.slice(0, 512) } };
      const output = path.join(folder, `output.${kind}`);
      await execute(['--from=json', `--to=${kind}`, '--standalone', '--fail-if-warnings', ...(referencePath ? [`--reference-doc=${referencePath}`] : []), `--output=${output}`], JSON.stringify(safe.ast));
      const bytes = await fs.readFile(output); if (bytes.length > MAX) throw new Error(t("转换后的文件过大。")); return bytes;
    });
  }
  async importDocument(file) {
    const extension = path.extname(file).toLowerCase();
    if (!['.docx', '.html', '.htm'].includes(extension)) throw new Error(t("仅支持导入 DOCX 或 HTML。"));
    const info = await fs.stat(file); if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error(t("导入文件需小于 32 MiB。"));
    return this.temporary(async (folder, execute) => {
      const input = path.join(folder, `input${extension}`); await fs.copyFile(file, input);
      const ast = JSON.parse((await execute([`--from=${extension === '.docx' ? 'docx' : 'html+raw_html'}`, '--to=json', '--fail-if-warnings', ...(extension === '.docx' ? ['--extract-media=media'] : []), input], '')).toString('utf8'));
      const safe = await cleanAst(ast, async value => {
        if (imageData(value)) return value;
        if (extension !== '.docx' || typeof value !== 'string' || path.isAbsolute(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
        const candidate = await fs.realpath(path.resolve(folder, value)).catch(() => null);
        if (!candidate || !isWithin(candidate, path.join(folder, 'media'))) return null;
        const imageInfo = await fs.stat(candidate); if (imageInfo.size > 20 * 1024 * 1024) throw new Error(t("导入图片超过 20 MiB。"));
        const mime = { '.png':'png', '.jpg':'jpeg', '.jpeg':'jpeg', '.gif':'gif', '.webp':'webp' }[path.extname(candidate).toLowerCase()];
        if (!mime) return null;
        return `data:image/${mime};base64,${(await fs.readFile(candidate)).toString('base64')}`;
      });
      const content = (await execute(['--from=json', '--to=gfm+tex_math_dollars-tex_math_gfm-raw_html', '--wrap=none', '--fail-if-warnings'], JSON.stringify(safe.ast))).toString('utf8');
      if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error(t("转换后的 Markdown（含图片）超过 16 MiB。"));
      return { name: `${path.parse(file).name}.md`, content, warnings: safe.warnings };
    });
  }
}
module.exports = { PandocService, cleanAst, imageData, supportedVersion };

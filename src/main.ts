import { t, ht, getLocale, isLocale } from '../electron/i18n.mjs';
import type { BootState, DocumentFile, Settings, Workspace, RecentFile, WorkspaceRequest, DocumentStatus } from '../shared/moye';
import { WorkspaceUI, type OpenLocation } from './workspace-ui';
import { WritingEditor } from './editor';
import { WritingTools } from './writing-tools';
import { DocumentTabs } from './document-tabs';
import { PaneWorkspace, type DockRequest } from './pane-workspace';
import { SnapshotDialog } from './snapshots';
import { MediaController } from './media-controller';
import { OutlinePanel } from './outline-panel';
import { FormatMenu } from './format-menu';
import { Shortcuts } from './shortcuts';
import { AttachmentOrganizer } from './attachment-organizer';
import { UpdateDialog } from './update-dialog';
import { AboutDialog } from './about-dialog';
import { ImageHostingDialog } from './image-hosting';
import { ImageActions } from './image-actions';
import { icon, logo } from './icons';
import { welcome } from './welcome';
import { exportHTML } from './export';
import { ExportDialog } from './export-dialog';
import { prepareExportAssets, installDiagramActions } from './export-assets';
import type { ExportOptions } from '../shared/export';
import { renderMath } from './math-engine';
import { installMathCopyActions } from './math-copy';
import { normalizeCustomCss, writingAppearance } from './appearance';
import './style.css';
import './print.css';
import './formula.css';
import './settings.css';
import './writing-tools.css';
import './editing-tools.css';

const escapeHTML = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const button = (action: string, label: string, glyph: string, cls = '') => `<button type="button" class="icon-button ${cls}" data-action="${action}" title="${label}" aria-label="${label}">${icon(glyph)}</button>`;

document.querySelector('#app')!.innerHTML = `
<div class="shell" id="shell">
  <aside class="sidebar" aria-label="${ht("文档导航")}">
    <div class="brand"><button type="button" class="brand-mark" data-action="about" title="${ht("关于 Meki")}" aria-label="${ht("关于 Meki")}">${logo}</button><span>Meki</span></div>
    <div class="file-actions"><button class="open-button" data-action="open">${icon('folder')}<span>${ht("打开文稿")}</span><kbd id="open-shortcut">Ctrl O</kbd></button>${button('new', t("新建文稿"), 'plus')}</div>
    <button class="workspace-label" data-action="recent-folders" aria-haspopup="dialog" aria-label="${ht("切换工作区或管理最近文件夹")}"><span id="workspace-name">${ht("个人写作空间")}</span>${icon('down', 14)}</button>
    <div class="sidebar-tabs" role="tablist" aria-label="${ht("导航方式")}"><button role="tab" data-tab="files" aria-selected="false">${ht("文件")}</button><button role="tab" class="active" data-tab="outline" aria-selected="true">${ht("大纲")}</button></div>
    <div id="files-panel" hidden><div class="file-filter">${icon('search', 15)}<input id="file-filter" placeholder="${ht("搜索文件")}" aria-label="${ht("搜索本地文件")}"></div><div id="file-list"></div></div>
    <nav id="outline-panel" aria-label="${ht("文档大纲")}"><div id="outline-list"></div></nav>
    <div class="sidebar-bottom"><span class="local-dot"></span><span>${ht("纯文本，留在你手中")}</span><button type="button" class="update-entry" data-action="updates">${ht("检查更新")}</button>${button('help', t("使用指南与快捷键"), 'help')}</div>
  </aside>
  <section class="main-area">
    <header class="titlebar">
      <div class="document-location">${button('sidebar', t("显示或隐藏侧栏"), 'layout')}<span class="breadcrumb">${ht("文稿")}</span>${icon('chevron', 12)}<span id="document-name">${ht("开始写作.md")}</span><span class="dirty-dot" id="dirty-dot" hidden></span></div>
      <div class="title-actions"><button id="toggle-autosave" class="lifecycle-button" data-action="toggle-autosave" aria-pressed="false">${ht("自动保存：关")}</button><button class="lifecycle-button" data-action="snapshots">${ht("快照")}</button><span class="save-state" id="save-state"><span class="saved-tick">✓</span> ${ht("就绪")}</span><button class="save-button" data-action="save">${icon('save', 15)}<span>${ht("保存")}</span></button></div>
    </header>
    <div class="formatbar" aria-label="${ht("编辑工具栏")}">
      <div class="format-actions"><select id="heading-format" aria-label="${ht("段落样式")}"><option value="paragraph">${ht("正文")}</option><option value="h1">${ht("一级标题")}</option><option value="h2">${ht("二级标题")}</option><option value="h3">${ht("三级标题")}</option></select><span class="divider"></span><button class="icon-button text-icon" data-format="bold" title="${ht("粗体 Ctrl/⌘ B")}" aria-label="${ht("粗体")}"><b>B</b></button><button class="icon-button text-icon" data-format="italic" title="${ht("斜体 Ctrl/⌘ I")}" aria-label="${ht("斜体")}"><i>I</i></button><button class="icon-button" data-format="list" title="${ht("无序列表")}" aria-label="${ht("无序列表")}">${icon('list')}</button><span class="divider"></span>${button('math', t("插入数学公式"), 'formula')}${button('diagram', t("插入 Mermaid 图表"), 'diagram')}<button class="icon-button" data-format="code" title="${ht("插入代码块")}" aria-label="${ht("插入代码块")}">${icon('source')}</button>${button('image', t("插入图片"), 'image')}</div>
      <div class="view-actions"><div class="mode-switch" aria-label="${ht("编辑模式")}"><button data-mode="visual" class="active" aria-pressed="true">${ht("编辑")}</button><button data-mode="source" aria-pressed="false">${ht("源码")}</button></div><span class="divider"></span>${button('find', t("查找文稿 Ctrl/⌘ F"), 'search')}${button('focus', t("专注模式"), 'focus')}${button('style', t("外观与排版"), 'style')}${button('export', t("导出文稿"), 'export')}</div>
    </div>
    <div id="recovery-banner" class="recovery-banner" hidden><span>${ht("已恢复文稿内容，尚未写入文件。确认后请手动保存。")}</span><button data-action="dismiss-recovery" aria-label="${ht("关闭恢复提示")}">${icon('close', 14)}</button></div>
    <div id="find-panel" class="find-panel" hidden>${icon('search', 16)}<input id="find-query" placeholder="${ht("查找文稿中的文字")}" aria-label="${ht("查找文字")}"><span id="find-count"></span>${button('find-prev', t("上一个匹配"), 'back')}${button('find-next', t("下一个匹配"), 'chevron')}${button('find-close', t("关闭查找"), 'close')}</div>
    <main class="document-scroll" id="document-scroll"><div id="loading" class="loading">${ht("正在准备你的写作空间…")}</div><div id="visual-editor" class="editor-host" aria-label="${ht("即时预览编辑区")}"></div><div id="source-editor" hidden></div></main>
    <footer class="statusbar"><span id="document-state">${ht("本地 Markdown")}</span><span class="footer-right"><span id="word-count">${ht("0 字")}</span><span class="footer-separator">·</span><span id="reading-time">${ht("1 分钟阅读")}</span><button data-action="style" id="font-status">18 px</button><span class="encoding">UTF-8</span></span></footer>
  </section>
</div>
<div class="popover style-panel" id="style-panel" hidden>
  <label class="setting-row">Language / 语言<select id="ui-language" aria-label="Language / 语言"><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
  <p class="setting-note" id="language-restart-note" role="status" hidden>${ht('语言设置已保存。退出并重新打开应用后，所有窗口将使用所选语言。')}</p>
  <div class="popover-title">${ht("给文字一点空间")}<span>${ht("外观与排版")}</span></div>
  <div class="theme-choices"><button data-theme="paper" aria-label="${ht("纸白主题")}"><span class="theme-sample paper">Aa</span><span>${ht("纸白")}</span></button><button data-theme="linen" aria-label="${ht("亚麻主题")}"><span class="theme-sample linen">Aa</span><span>${ht("亚麻")}</span></button><button data-theme="night" aria-label="${ht("夜墨主题")}"><span class="theme-sample night">Aa</span><span>${ht("夜墨")}</span></button></div>
  <label class="setting-row">${ht("字体")}<select id="font-family"><option value="serif">${ht("人文衬线")}</option><option value="sans">${ht("清晰无衬线")}</option></select></label>
  <label class="setting-row">${ht("本机字体")}<input id="custom-font" placeholder="${ht("使用默认字体")}" maxlength="128" aria-label="${ht("本机字体名称")}"></label>
  <div class="setting-row"><label for="font-size">${ht("字号")}</label><input id="font-size" type="range" min="14" max="24" step="1"><output id="font-size-value">18</output></div>
  <label class="setting-row">${ht("正文宽度")}<select id="line-width"><option value="640">${ht("紧凑 · 640")}</option><option value="760">${ht("适中 · 760")}</option><option value="900">${ht("舒展 · 900")}</option></select></label>
  <label class="setting-row">${ht("公式编号")}<select id="math-numbering"><option value="none">${ht("仅手动编号")}</option><option value="ams">${ht("AMS 环境自动编号")}</option><option value="all">${ht("所有独立公式自动编号")}</option></select></label>
  <label class="setting-row">${ht("物理公式宏")}<input id="math-physics" type="checkbox" aria-label="${ht("启用物理公式宏")}"></label>
  <button class="theme-edit-button" data-action="custom-theme">${ht("自定义正文 CSS")} <span>${ht("编辑或导入 →")}</span></button>
  <p class="setting-note">${ht("排版设置同时用于编辑与导出。自定义字体需在阅读设备上安装。")}</p>
</div>
<div class="popover export-panel" id="export-panel" hidden><span class="menu-label">${ht("导出当前文稿")}</span><button data-action="export-options">${icon('export')}<span>${ht("格式与导出设置…")}<small>${ht("PDF 纸张、PNG、Word、EPUB、无样式 HTML")}</small></span></button><button data-action="export-html">${icon('source')}<span>${ht("快速导出 HTML")}<small>${ht("包含排版、公式、图表与本地图片")}</small></span></button><button data-action="export-pdf">${icon('page')}<span>${ht("快速导出 PDF")}<small>${ht("A4 纵向 · 默认边距")}</small></span></button><button data-action="import-document">${icon('open')}<span>${ht("导入 Word / HTML…")}<small>${ht("转换为新 Markdown 文稿，原文件保留")}</small></span></button><button data-action="saveAs">${icon('save')}<span>${ht("Markdown 另存为")}<small>${ht("可在任何文本编辑器中打开")}</small></span></button></div>
<dialog id="math-dialog"><form method="dialog"><div class="dialog-heading"><div><span class="eyebrow">MATHEMATICS</span><h2>${ht("让公式清晰呈现")}</h2></div><button value="cancel" class="icon-button" aria-label="${ht("关闭公式窗口")}">${icon('close')}</button></div><label class="field-label" for="math-input">${ht("LaTeX 公式")}</label><textarea id="math-input" rows="3" spellcheck="false" placeholder="${ht("例如：\\frac{a}{b} 或 E = mc^2")}"></textarea><div class="math-examples"><button type="button" data-math-example="E = mc^2">${ht("能量")}</button><button type="button" data-math-example="\\frac{a}{b}">${ht("分式")}</button><button type="button" data-math-example="\\int_0^1 x^2\\,dx = \\frac{1}{3}">${ht("积分")}</button></div><div class="math-preview" id="math-preview"></div><div class="dialog-actions"><select id="math-kind" aria-label="${ht("公式显示方式")}"><option value="block">${ht("独立公式块")}</option><option value="inline">${ht("行内公式")}</option></select><button class="primary-button" type="button" data-action="insert-math">${ht("插入公式")}</button></div></form></dialog>
<dialog id="theme-dialog"><form method="dialog">
  <div class="dialog-heading"><div><span class="eyebrow">YOUR WRITING STYLE</span><h2>${ht("定义你的正文风格")}</h2></div><button value="cancel" class="icon-button" aria-label="${ht("关闭主题窗口")}">×</button></div>
  <p class="theme-help">${ht("设置标题、段落、颜色和间距。支持")} <code>body</code>、<code>.meki-document</code>、<code>.ProseMirror</code> ${ht("作为正文容器；仅应用排版规则，图片和网络字体不会加载。")}</p>
  <label class="field-label" for="custom-css">${ht("正文 CSS")}</label>
  <textarea id="custom-css" rows="11" spellcheck="false" placeholder="h1 { color: #416b5b; }&#10;p { line-height: 1.9; }"></textarea>
  <p id="theme-feedback" role="status"></p>
  <div class="dialog-actions"><div><button type="button" class="secondary-button" data-action="import-theme">${ht("导入 CSS")}</button><button type="button" class="text-button" data-action="reset-theme">${ht("恢复默认")}</button></div><button type="button" class="primary-button" data-action="apply-theme">${ht("应用主题")}</button></div>
</form></dialog>
<dialog id="help-dialog"><form method="dialog"><div class="dialog-heading"><div><span class="eyebrow">${ht("MEKI")}</span><h2>${ht("开始一页新的想法")}</h2></div><button value="close" class="icon-button" aria-label="${ht("关闭指南")}">${icon('close')}</button></div><p>${ht("直接在编辑区写作，Markdown 标记会自动变成排版。在空白行输入")} <code>/</code> ${ht("插入标题、列表、表格或公式。")}</p><p>${ht("工具栏的“插入 Mermaid 图表”会创建可编辑的流程图。也可用")} <code>\`\`\`mermaid</code> ${ht("代码围栏输入图表，点击预览编辑源码；HTML 和 PDF 会保留图表。")}</p><div class="shortcut-list"><span>${ht("新建文稿")}</span><kbd>Ctrl / ⌘ N</kbd><span>${ht("打开文件")}</span><kbd>Ctrl / ⌘ O</kbd><span>${ht("保存文件")}</span><kbd>Ctrl / ⌘ S</kbd><span>${ht("另存为")}</span><kbd>Ctrl / ⌘ Shift S</kbd><span>${ht("源码与编辑切换")}</span><kbd>Ctrl / ⌘ /</kbd><span>${ht("查找")}</span><kbd>Ctrl / ⌘ F</kbd><span>${ht("专注模式")}</span><kbd>Ctrl / ⌘ Shift F</kbd></div><p class="help-note">${ht("未保存的修改会自动保留为本地恢复草稿。自动写回默认关闭，可在标签栏“文稿与保存”中开启。公式支持常用 LaTeX 数学语法。")}</p><button class="primary-button" value="close">${ht("开始写作")}</button></form></dialog>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>`;

let current: DocumentFile = { path: null, name: t("开始写作.md"), content: welcome, revision: null };
let settings: Settings;
let workspace: Workspace | null = null;
let recentFiles: RecentFile[] = [];
let editor: WritingEditor;
let panes: PaneWorkspace;
let writingTools: WritingTools | undefined;
let media: MediaController | undefined;
let documentId = 0;
let outline: OutlinePanel | undefined;
let formatMenu: FormatMenu | undefined;
let shortcuts: Shortcuts | undefined;
let updateDialog: UpdateDialog | undefined;
let aboutDialog: AboutDialog | undefined;
let busy = false;
let closeRequested = false;
let ready = false;
let draftTimer: ReturnType<typeof setTimeout>;
let outlineTimer: ReturnType<typeof setTimeout>;
let toastTimer: ReturnType<typeof setTimeout>;
let platform = '';
let syncingWorkspace = false;
let composing = false;
let savingAutomatically = false;
let lifecycleSettingsQueue: Promise<void> = Promise.resolve();
let lifecycleSettingsPending = 0;
const externalBanner = document.createElement('div');
externalBanner.id = 'external-banner'; externalBanner.className = 'external-banner'; externalBanner.hidden = true;
externalBanner.innerHTML = `<span id="external-message"></span><button data-action="reload-document">${ht("重新载入")}</button><button data-action="saveAs">${ht("另存为")}</button><button data-action="dismiss-external">${ht("保留当前内容")}</button>`;
el('#recovery-banner').after(externalBanner);
const workspaceUI = new WorkspaceUI({ document: () => current, open: location => dispatch('workspace-open', location), operation: request => dispatch('workspace-operation', request), choose: () => dispatch('folder'), openFolder: path => perform(() => openRecentFolder(path), false, true), refresh: () => dispatch('refresh'), notify });
const documents = new DocumentTabs({ editor: () => editor, settings: () => settings, platform: () => platform, panes: () => panes,
  active: doc => { documentId++; outline?.reset(); current = doc; }, updated: () => { renderOutline(); renderFiles(); updateStatus(); renderExternalStatus(); },
  dispatch: (command, payload) => { void dispatch(command, payload); }, notify });
const snapshotDialog = new SnapshotDialog({ documents, platform: () => platform, run: action => perform(action, true, true), notify });
const attachmentOrganizer = new AttachmentOrganizer({ document: () => current, activeId: () => documents.activeId,
  editor: () => editor, run: action => perform(action, true, true), pause: () => { documents.active.paused = 'attachments'; }, persist: persistDraft, notify });
const imageHostingDialog = new ImageHostingDialog({ document: () => current, activeId: () => documents.activeId,
  editor: () => editor, settings: () => settings, saveSettings: async patch => { settings = await window.moye.updateSettings(patch); applySettings(); },
  run: action => perform(action, true, true), pause: () => { documents.active.paused = 'attachments'; }, persist: persistDraft, notify });
new ImageActions({ editor: () => editor, document: () => current, activeId: () => documents.activeId, settings: () => settings,
  run: action => perform(action, true, true), pause: () => { documents.active.paused = 'attachments'; }, persist: persistDraft,
  upload: source => imageHostingDialog.uploadDocument(source), notify });
const documentStyle = document.createElement('style');
documentStyle.id = 'document-appearance';
document.head.appendChild(documentStyle);
const mathPreviewStyle = document.createElement('style');
document.head.appendChild(mathPreviewStyle);
const dirty = () => documents.dirty();
function notify(message: string, error = false) {
  clearTimeout(toastTimer); const toast = el('#toast'); toast.textContent = message.replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '');
  toast.classList.toggle('error', error); toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 6500 : 3500);
}
async function perform(fn: () => Promise<void>, freezeDocument = false, propagateError = false) {
  if (busy || !ready) { if (propagateError) throw new Error(t("正在处理上一个操作，请稍后再试。")); return; } busy = true; document.body.classList.add('is-busy');
  if (freezeDocument) { editor.flush(); el('#editor-workspace').inert = true; el('.formatbar').inert = true; }
  try { await fn(); } catch (error) { if (propagateError) throw error; notify(String(error), true); }
  finally {
    el('#editor-workspace').inert = false; el('.formatbar').inert = false; busy = false; document.body.classList.remove('is-busy'); updateStatus();
    if (closeRequested) { closeRequested = false; queueMicrotask(() => { void dispatch('close-request'); }); }
  }
}
function updateStatus() {
  if (!ready) return;
  el('#document-name').textContent = current.name;
  el('#document-name').title = current.path || t("尚未保存到文件");
  el('#dirty-dot').hidden = !dirty();
  el('#save-state').innerHTML = savingAutomatically ? t("自动保存中…") : busy ? t("处理中…") : dirty() ? `<span class="unsaved-tick">●</span> ${ht("未保存")}` : current.path ? `<span class="saved-tick">✓</span> ${ht("已保存")}` : t("本地文稿");
  el('#toggle-autosave').textContent = t("自动保存：{0}", settings.autoSave ? t("开") : t("关"));
  el('#toggle-autosave').setAttribute('aria-pressed', String(settings.autoSave));
  el('#toggle-autosave').title = settings.autoSave ? t("停止输入 {0} 秒后保存。点击关闭；标签栏 ••• 可设置间隔。", settings.autoSaveInterval) : t("点击开启自动保存；标签栏 ••• 可设置保存和快照间隔。");
  el('#document-state').textContent = documents.pauseMessage() || (settings.autoSave ? current.path ? t("停止输入 {0} 秒后自动保存", settings.autoSaveInterval) : t("未命名文稿 · 请先保存到文件") : editor.mode === 'source' ? t("Markdown 源码") : t("即时预览"));
  documents.render();
  const cjk = (current.content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const words = (current.content.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  el('#word-count').textContent = t("{0} 字", (cjk + words).toLocaleString(getLocale()));
  el('#reading-time').textContent = t("{0} 分钟阅读", Math.max(1, Math.ceil((cjk + words) / 400)));
  void window.moye.setDocumentState({ name: current.name, path: current.path, dirty: dirty() }).catch(() => {});
}
async function persistDraft() {
  clearTimeout(draftTimer);
  await documents.persist();
}
function connectEditor(value: WritingEditor, visual: HTMLElement) {
  writingTools?.connect(value); formatMenu?.connect(value); return media?.connect(value, visual);
}
function changed(content: string) {
  if (content === current.content) return;
  current.content = content; documents.touched(); updateStatus();
  clearTimeout(draftTimer); draftTimer = setTimeout(() => { void persistDraft().catch(error => notify(t("草稿保存失败：{0}", error), true)); }, 600);
  clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 250);
}
function renderOutline() {
  outline?.update(current.content);
}
function renderFiles() {
  workspaceUI.render(workspace, current.path, recentFiles);
}

async function synchronizeWorkspace() {
  if (!ready || busy || syncingWorkspace || document.hidden || document.querySelector('dialog[open]')) return;
  syncingWorkspace = true;
  const selected = documents.active, documentPath = current.path, revision = current.revision, root = workspace?.root;
  try {
    const [tree, status] = await Promise.allSettled([root ? window.moye.refreshWorkspace() : Promise.resolve(null), documentPath ? window.moye.checkDocument(documentPath,revision) : Promise.resolve(null)]);
    if (busy) return;
    if (tree.status === 'fulfilled' && root === workspace?.root && tree.value && JSON.stringify(tree.value) !== JSON.stringify(workspace)) { workspace = tree.value; renderFiles(); }
    if (status.status === 'fulfilled' && documentPath === current.path && revision === current.revision) {
      selected.status = status.value;
      if (status.value && status.value.state !== 'unchanged' && !['history', 'recovered'].includes(selected.paused || '')) selected.paused = 'external';
      renderExternalStatus(); updateStatus();
    }
  } finally { syncingWorkspace = false; }
}
function renderExternalStatus() {
  const tab = documents.active, status = tab?.status;
  externalBanner.hidden = !status || status.state === 'unchanged' || `${status.state}:${status.revision}` === tab.acknowledged;
  if (!externalBanner.hidden) {
    el('#external-message').textContent = status!.state === 'missing' ? t("磁盘文件已移走或删除。编辑内容仍在；自动保存已暂停。") : t("磁盘文件已被其他程序修改。编辑内容保持不变；自动保存已暂停。");
    externalBanner.querySelector<HTMLButtonElement>('[data-action="reload-document"]')!.disabled = status!.state === 'missing';
  }
}

function remapDocumentPath(filePath: string, from: string, to: string | null): string | null | undefined {
  const slash = (value: string) => value.replace(/\\/g,'/').replace(/\/$/,'');
  const source = slash(from), file = slash(filePath);
  const key = (value: string) => platform === 'win32' ? value.toLocaleLowerCase() : value;
  if (key(file) !== key(source) && !key(file).startsWith(`${key(source)}/`)) return undefined;
  return to === null ? null : to + file.slice(source.length).replace(/\//g,to.includes('\\')?'\\':'/');
}

async function openLocation(location: OpenLocation) {
  if (location.path !== current.path) {
    const doc = await window.moye.openDocument(location.path); if (!doc) return;
    await loadDocument(doc);
  }
  if (location.line) { switchMode('source'); editor.goToLine(location.line, location.column || 1); }
  else if (location.anchor) {
    switchMode('visual');
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const target = [...el('#visual-editor').querySelectorAll<HTMLElement>('[id]')].find(node => node.id === location.anchor);
    if (target) target.scrollIntoView({block:'center'}); else notify(t("没有找到标题锚点：{0}", location.anchor));
  } else editor.focus();
}
async function openRecentFolder(path: string) {
  workspace = await window.moye.openRecentFolder(path); setSidebarTab('files'); renderFiles();
}

async function workspaceOperation(request: WorkspaceRequest) {
  const result = await window.moye.workspaceOperation(request); if (!result) return;
  workspace = result.workspace;
  if (result.previousPath && ['move','rename','trash'].includes(result.action)) {
    recentFiles = recentFiles.flatMap(file => { const path = remapDocumentPath(file.path,result.previousPath!,result.path); return path === null ? [] : [{...file,path:path || file.path,name:path ? path.split(/[\\/]/).pop()! : file.name}]; });
    workspaceUI.remap(filePath => remapDocumentPath(filePath,result.previousPath!,result.path));
    documents.remap(filePath => remapDocumentPath(filePath,result.previousPath!,result.path));
    await persistDraft(); updateStatus();
  }
  renderFiles();
  if (result.action === 'create-file' && result.path) { const doc = await window.moye.openDocument(result.path); if (doc) await loadDocument(doc); }
  notify(result.warning || (result.action === 'trash' ? t("已移入系统回收站，当前文稿内容仍保留") : t("文件操作已完成")), Boolean(result.warning));
}
function applySettings() {
  el<HTMLSelectElement>('#ui-language').value = settings.locale;
  el('#language-restart-note').hidden = settings.locale === getLocale();
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.font = settings.font;
  document.documentElement.style.setProperty('--writing-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--line-width', `${settings.lineWidth}px`);
  document.body.classList.toggle('focus-mode', settings.focus);
  document.body.classList.toggle('sidebar-hidden', !settings.sidebar);
  el<HTMLSelectElement>('#font-family').value = settings.font;
  el<HTMLInputElement>('#custom-font').value = settings.fontFamily;
  el<HTMLSelectElement>('#math-numbering').value = settings.mathNumbering;
  el<HTMLInputElement>('#math-physics').checked = settings.mathPhysics;
  el<HTMLInputElement>('#font-size').value = String(settings.fontSize);
  el('#font-size-value').textContent = String(settings.fontSize);
  el<HTMLSelectElement>('#line-width').value = String(settings.lineWidth);
  el('#font-status').textContent = `${settings.fontSize} px`;
  document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => { const selected = button.dataset.theme === settings.theme; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  document.querySelector('[data-action="focus"]')?.classList.toggle('active', settings.focus);
  documentStyle.textContent = writingAppearance(settings);
  for (const view of panes?.views.values() || []) view.editor.updateSettings(settings);
  writingTools?.apply(settings);
  formatMenu?.apply(settings);
  outline?.apply(settings);
  shortcuts?.apply();
}
function changeSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }; applySettings();
  void window.moye.updateSettings(patch).catch(error => notify(String(error), true));
}
function closePopovers() { el('#style-panel').hidden = true; el('#export-panel').hidden = true; }
function switchMode(mode: 'visual' | 'source') {
  if (editor.mode === mode) return; editor.flush(); editor.setMode(mode, current.content);
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  updateStatus(); outline?.schedule();
}
async function loadDocument(doc: DocumentFile, recovered = false) {
  clearTimeout(draftTimer);
  await documents.open(doc, recovered);
  if (doc.path) recentFiles = [{ path: doc.path, name: doc.name }, ...recentFiles.filter(f => f.path !== doc.path)].slice(0, 15);
  renderOutline(); renderFiles(); updateStatus();
}
async function save(saveAs = false) {
  if (!await documents.save(documents.active, saveAs)) return false;
  if (current.path) recentFiles = [{ path: current.path, name: current.name }, ...recentFiles.filter(f => f.path !== current.path)].slice(0, 15);
  if (workspace) workspace = await window.moye.refreshWorkspace().catch(() => workspace);
  renderFiles(); updateStatus(); notify(documents.recoveryError || t("已保存 · {0}", current.name), Boolean(documents.recoveryError)); return true;
}
async function mayReplace() {
  editor.flush(); if (!dirty()) return true;
  const answer = await window.moye.confirmDiscard(current.name);
  if (answer === 'cancel') return false;
  if (answer === 'save') return (await save()) && !dirty();
  return true;
}
function showMath() {
  closePopovers(); el<HTMLDialogElement>('#math-dialog').showModal(); updateMathPreview(); el<HTMLTextAreaElement>('#math-input').focus();
}
function updateMathPreview() {
  const latex = el<HTMLTextAreaElement>('#math-input').value.trim();
  if (!latex) { el('#math-preview').innerHTML = `<span class="math-placeholder">${ht("公式预览会出现在这里")}</span>`; return; }
  const result = renderMath(latex, el<HTMLSelectElement>('#math-kind').value === 'block', settings);
  mathPreviewStyle.textContent = result.css;
  el('#math-preview').innerHTML = result.html;
}
async function runExport(options: ExportOptions) {
  await perform(async () => {
    editor.flush(); const snapshot = { ...current }, appearance = { ...settings };
    if (options.theme && options.theme !== 'current') appearance.theme = options.theme;
    if (options.fontSize) appearance.fontSize = options.fontSize;
    if (['docx', 'epub', 'plain-html'].includes(options.kind)) { appearance.theme = 'paper'; appearance.customCss = ''; }
    let html = await prepareExportAssets(await exportHTML(snapshot.content, snapshot.name, snapshot.path, appearance, options.kind === 'docx'), options.kind);
    if (options.kind === 'pdf' && options.pdf?.pageBreakBeforeH1) html = html.replace('</head>', '<style>@media print { .moye-document > h1 ~ h1 { break-before:page; page-break-before:always; } }</style></head>');
    const output = await window.moye.exportFile({ ...options, html, suggestedName: snapshot.name.replace(/\.(md|markdown|mdown|txt)$/i, '') });
    if (output) notify(t("已导出 {0} · {1}{2}", options.kind.toUpperCase(), output.path.split(/[\\/]/).pop(), output.math ? t("；{0} 个可编辑公式，{1} 个公式保留为图片", output.math.editable, output.math.fallback) : ''));
  });
}
const exportDialog = new ExportDialog(runExport);
async function dispatch(action: string, payload?: unknown) {
  if (action === 'window-notice') { notify(String(payload)); return; }
  if (action === 'settings-changed' && ready) {
    settings = { ...settings, ...payload as Partial<Settings> }; applySettings(); updateStatus(); documents.refreshSettings(); return;
  }
  if (action === 'close-request' && busy) { closeRequested = true; return; }
  if (action === 'snapshot-warning') { notify(String(payload), true); return; }
  if (!ready) return;
  if (action === 'lifecycle-setting' || action === 'toggle-autosave') {
    // Preserve rapid checkbox changes while the preceding settings write is still pending.
    lifecycleSettingsPending++;
    lifecycleSettingsQueue = lifecycleSettingsQueue.then(async () => {
      const patch = action === 'toggle-autosave' ? { autoSave: !settings.autoSave } : payload as Partial<Settings>;
      await window.moye.updateSettings(patch);
      settings = { ...settings, ...patch }; applySettings(); updateStatus();
    }).catch(error => { documents.refreshSettings(); notify(String(error), true); }).finally(() => { lifecycleSettingsPending--; });
    await lifecycleSettingsQueue; return;
  }
  if (busy) return;
  if (action === 'shortcut-settings') { closePopovers(); await shortcuts?.open(); return; }
  if (action === 'window-menu') { closePopovers(); documents.toggleWindows(); return; }
  if (action === 'autosave-blur') {
    if (!composing && !lifecycleSettingsPending && settings.autoSaveOnBlur && !document.querySelector('dialog[open]')) {
      editor.flush(); if (documents.autosaveDue(true)) await dispatch('autosave', true);
    }
    return;
  }
  if (action === 'snapshots') { closePopovers(); el('#lifecycle-settings').hidden = true; await snapshotDialog.open(); return; }
  if (action === 'organize-attachments') { closePopovers(); await attachmentOrganizer.open(); return; }
  if (action === 'image-hosting') { closePopovers(); imageHostingDialog.open(); return; }
  if (action === 'upload-document-images') { closePopovers(); await imageHostingDialog.uploadDocument(); return; }
  if (action === 'recent-folders') { closePopovers(); await workspaceUI.showFolders(); return; }
  if (action === 'quick-open' || action === 'workspace-search') { closePopovers(); workspaceUI.showPicker(action === 'quick-open' ? 'quick' : 'search'); return; }
  if (action === 'dismiss-external') { documents.active.acknowledged = `${documents.active.status?.state}:${documents.active.status?.revision}`; externalBanner.hidden = true; return; }
  if (action === 'lifecycle-settings') { closePopovers(); documents.toggleSettings(); return; }
  if (action.startsWith('edit-')) { formatMenu?.execute(action.slice(5)); return; }
  if (action === 'style' || action === 'export') { const node = el(`#${action}-panel`); const show = node.hidden; closePopovers(); node.hidden = !show; return; }
  closePopovers();
  if (action === 'export-options') { exportDialog.open(); return; }
  if (action === 'export-html' || action === 'export-pdf') { await runExport({ kind: action === 'export-html' ? 'html' : 'pdf' }); return; }
  if (action === 'sidebar') return changeSettings({ sidebar: !settings.sidebar });
  if (action === 'focus') { changeSettings({ focus: !settings.focus }); if (settings.focus) notify(t("专注模式 · Ctrl/⌘ Shift F 返回")); return; }
  if (action === 'typewriter') return changeSettings({ typewriter: !settings.typewriter });
  if (action === 'paragraph-focus') return changeSettings({ paragraphFocus: !settings.paragraphFocus });
  if (action === 'spellcheck') return changeSettings({ spellcheck: !settings.spellcheck });
  if (action === 'source') return switchMode(editor.mode === 'visual' ? 'source' : 'visual');
  if (action === 'math') return showMath();
  if (action === 'custom-theme') {
    el<HTMLTextAreaElement>('#custom-css').value = settings.customCss;
    el('#theme-feedback').textContent = '';
    el<HTMLDialogElement>('#theme-dialog').showModal(); return;
  }
  if (action === 'apply-theme' || action === 'reset-theme') {
    const css = action === 'reset-theme' ? '' : el<HTMLTextAreaElement>('#custom-css').value;
    try {
      normalizeCustomCss(css);
      changeSettings({ customCss: css });
      el<HTMLDialogElement>('#theme-dialog').close();
      notify(css ? t("已应用正文主题") : t("已恢复内置排版"));
    } catch (error) { el('#theme-feedback').textContent = t("CSS 格式有误：{0}", String(error).replace(/^Error: /, '')); }
    return;
  }
  if (action === 'help') { el<HTMLDialogElement>('#help-dialog').showModal(); return; }
  if (action === 'about') { closePopovers(); aboutDialog?.open(); return; }
  if (action === 'updates') { await updateDialog?.open(); return; }
  if (action === 'image') { await media?.choose(); return; }
  if (action === 'diagram') { editor.insertMarkdown(t("\n```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```\n")); return; }
  if (action === 'dismiss-recovery') { documents.active.recovered = false; el('#recovery-banner').hidden = true; return; }
  if (action === 'insert-math') {
    const latex = el<HTMLTextAreaElement>('#math-input').value.trim(); if (!latex) { el<HTMLTextAreaElement>('#math-input').focus(); return; }
    const block = el<HTMLSelectElement>('#math-kind').value === 'block'; el<HTMLDialogElement>('#math-dialog').close();
    editor.insertMarkdown(block ? `\n$$\n${latex}\n$$\n` : `$${latex}$`, !block); return;
  }
  if (action === 'find' || action === 'replace') { writingTools?.open(action === 'replace'); return; }
  if (action === 'find-close') { writingTools?.close(); editor.focus(); return; }
  if (action === 'find-next' || action === 'find-prev') { editor.search.navigate(action === 'find-next' ? 1 : -1); return; }
  await perform(async () => {
    if (action === 'new-window') { clearTimeout(draftTimer); editor.flush(); await persistDraft(); await window.moye.newWindow(); }
    if (action === 'detach-document') { clearTimeout(draftTimer); await documents.detach(typeof payload === 'string' ? payload : undefined); }
    if (action === 'dock-tab') { clearTimeout(draftTimer); await documents.dock(payload as DockRequest); }
    if (action === 'pane-layout') { clearTimeout(draftTimer); await documents.layout(payload as Parameters<DocumentTabs['layout']>[0]); }
    if (action === 'tile-windows') await window.moye.tileWindows();
    if (action === 'activate-tab') { documents.activate(String(payload)); await persistDraft(); }
    if (action === 'close-tab') { clearTimeout(draftTimer); await documents.close(typeof payload === 'string' ? payload : documents.activeId); }
    if (action === 'close-all') { clearTimeout(draftTimer); await documents.closeAll(); }
    if (action === 'reopen-closed') { clearTimeout(draftTimer); await documents.reopenClosed(); }
    if (action === 'autosave') {
      savingAutomatically = true; updateStatus();
      try { await documents.autosave(payload === true); }
      finally { savingAutomatically = false; }
    }
    if (action === 'auto-snapshots') await documents.autoSnapshots();
    if (action === 'history') await documents.showHistory();
    if (action === 'restore-version') await documents.restoreVersion(payload as { path: string; id: string; tabId: string });
    if (action === 'workspace-operation') await workspaceOperation(payload as WorkspaceRequest);
    if (action === 'workspace-open') await openLocation(payload as OpenLocation);
    if (action === 'open-folder') { if (typeof payload !== 'string') throw new Error(t("无效的最近文件夹路径。")); await openRecentFolder(payload); }
    if (action === 'document-link') {
      if (!current.path) throw new Error(t("请先保存文稿，再打开相对文件链接。"));
      const location = await window.moye.resolveDocumentLink(String(payload),current.path);
      await openLocation(location);
    }
    if (action === 'reload-document' && current.path && await mayReplace()) { const doc = await window.moye.openDocument(current.path); if (doc) await documents.reload(doc); }
    if (action === 'import-document') {
      const imported = await window.moye.importDocument();
      if (imported) {
        await loadDocument({ path: null, name: imported.name, content: imported.content, revision: null });
        documents.active.savedContent = '\u0000'; await persistDraft(); updateStatus();
        notify(imported.warnings.length ? t("已导入为未保存文稿。{0}", imported.warnings.join(' ')) : t("已导入为新 Markdown 文稿，请另存。"), imported.warnings.length > 0);
      }
    }
    if (action === 'import-theme') {
      const theme = await window.moye.importTheme();
      if (theme) {
        normalizeCustomCss(theme.css);
        el<HTMLTextAreaElement>('#custom-css').value = theme.css;
        el('#theme-feedback').textContent = t("已读取 {0}，点击“应用主题”保存。", theme.name);
      }
    }
    if (action === 'new') { await loadDocument({ path: null, name: t("未命名.md"), content: '', revision: null }); editor.focus(); }
    if (action === 'open' || action === 'open-path') {
      const doc = await window.moye.openDocument(typeof payload === 'string' ? payload : undefined);
      if (doc) {
        try { await loadDocument(doc); editor.focus(); }
        catch (error) { if (doc.path) await window.moye.releaseDocument(doc.path); throw error; }
      }
    }
    if (action === 'save' || action === 'saveAs') await save(action === 'saveAs');
    if (action === 'folder' || action === 'refresh') {
      const result = action === 'folder' ? await window.moye.chooseFolder() : await window.moye.refreshWorkspace();
      if (result) { workspace = result; setSidebarTab('files'); renderFiles(); }
    }
    if (action === 'close-request') {
      clearTimeout(draftTimer);
      try {
        await persistDraft();
        if (await documents.closeAll(true)) { if (!await window.moye.allowClose()) await persistDraft(); }
        else await window.moye.cancelClose();
      } catch (error) { await window.moye.cancelClose(); throw error; }
    }
  }, ['dock-tab', 'new', 'new-window', 'detach-document', 'open', 'open-path', 'close-request', 'close-tab', 'close-all', 'reopen-closed', 'activate-tab', 'restore-version', 'import-document', 'workspace-open', 'workspace-operation', 'document-link', 'reload-document'].includes(action));
  if (['dock-tab', 'activate-tab', 'close-tab', 'reopen-closed'].includes(action) || (action === 'pane-layout' && document.activeElement === document.body)) editor.focus();
}
function setSidebarTab(tab: string) {
  el('#files-panel').hidden = tab !== 'files'; el('#outline-panel').hidden = tab !== 'outline';
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(button => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
}
document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const preview = target.closest<HTMLElement>('.milkdown-code-block .preview');
  if (preview && !busy) {
    const block = preview.closest('.milkdown-code-block')!;
    if (block.querySelector('.codemirror-host.hidden')) {
      block.querySelector<HTMLButtonElement>('.preview-toggle-button')?.click();
      requestAnimationFrame(() => block.querySelector<HTMLElement>('.cm-content')?.focus());
    }
  }
  const action = target.closest<HTMLElement>('[data-action]');
  if (action) { void dispatch(action.dataset.action!); return; }
  const format = target.closest<HTMLElement>('[data-format]'); if (format && ready && !busy) { editor.format(format.dataset.format!); return; }
  const mode = target.closest<HTMLElement>('[data-mode]'); if (mode && ready && !busy) { switchMode(mode.dataset.mode as 'visual' | 'source'); return; }
  const tab = target.closest<HTMLElement>('[data-tab]'); if (tab) { setSidebarTab(tab.dataset.tab!); return; }
  const theme = target.closest<HTMLElement>('button[data-theme]'); if (theme) { changeSettings({ theme: theme.dataset.theme as Settings['theme'] }); return; }
  const file = target.closest<HTMLElement>('[data-file]'); if (file) { void dispatch('open-path', file.dataset.file); return; }
  const example = target.closest<HTMLElement>('[data-math-example]'); if (example) { el<HTMLTextAreaElement>('#math-input').value = example.dataset.mathExample!; updateMathPreview(); return; }
  const link = target.closest<HTMLAnchorElement>('.editor-host a[href]'); if (link) {
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) {
      try { [...el('#visual-editor').querySelectorAll<HTMLElement>('[id]')].find(node => node.id === href.slice(1) || node.id === decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* Ignore a malformed anchor. */ }
    } else if (event.ctrlKey || event.metaKey) {
      if (/^(https?:|mailto:)/i.test(href)) void window.moye.openExternal(href).catch(error => notify(String(error), true));
      else void dispatch('document-link',href);
    }
    return;
  }
  if (!target.closest('.popover')) closePopovers();
});
document.querySelector('.format-actions')!.addEventListener('mousedown', event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); });
el<HTMLSelectElement>('#ui-language').addEventListener('change', async event => {
  const select = event.target as HTMLSelectElement, locale = select.value;
  if (!isLocale(locale)) return;
  select.disabled = true;
  try { settings = await window.moye.updateSettings({ locale }); }
  catch (error) { notify(String(error), true); }
  finally { select.disabled = false; applySettings(); }
});
el<HTMLInputElement>('#font-size').addEventListener('input', event => changeSettings({ fontSize: Number((event.target as HTMLInputElement).value) }));
el<HTMLSelectElement>('#font-family').addEventListener('change', event => changeSettings({ font: (event.target as HTMLSelectElement).value as Settings['font'] }));
el<HTMLInputElement>('#custom-font').addEventListener('change', event => {
  const fontFamily = (event.target as HTMLInputElement).value.trim();
  if (fontFamily && !/^[\p{L}\p{N} _.-]{1,128}$/u.test(fontFamily)) { notify(t("请输入一个本机字体名称。"), true); el<HTMLInputElement>('#custom-font').value = settings.fontFamily; return; }
  changeSettings({ fontFamily });
});
el<HTMLSelectElement>('#math-numbering').addEventListener('change', event => changeSettings({ mathNumbering: (event.target as HTMLSelectElement).value as Settings['mathNumbering'] }));
el<HTMLInputElement>('#math-physics').addEventListener('change', event => changeSettings({ mathPhysics: (event.target as HTMLInputElement).checked }));
el<HTMLSelectElement>('#line-width').addEventListener('change', event => changeSettings({ lineWidth: Number((event.target as HTMLSelectElement).value) }));
el<HTMLSelectElement>('#heading-format').addEventListener('change', event => { editor.format((event.target as HTMLSelectElement).value); });
el('#math-input').addEventListener('input', updateMathPreview);
el('#math-kind').addEventListener('change', updateMathPreview);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing && !document.querySelector('dialog[open]')) { closePopovers(); if (!el('#find-panel').hidden) { writingTools?.close(); editor.focus(); } }
}, true);

async function start() {
  if (!window.moye) throw new Error(t("请通过 Meki 桌面应用打开编辑器（npm start）。"));
  const boot: BootState = await window.moye.boot();
  updateDialog = new UpdateDialog(async () => {
    await perform(async () => {
      try { if (await documents.closeAll(true)) await window.moye.applyUpdate(); }
      finally { await persistDraft(); }
    }, true, true);
  });
  platform = boot.platform;
  aboutDialog = new AboutDialog(boot.version, () => updateDialog!.open());
  document.body.classList.add(`platform-${boot.platform}`);
  settings = boot.settings; workspace = boot.workspace; recentFiles = boot.recentFiles; applySettings();
  panes = new PaneWorkspace({ settings: () => settings, blocked: () => busy || !ready || composing || !!document.querySelector('dialog[open]'),
    changed: (tab, content) => {
      if (tab.document.content === content) return;
      if (tab === documents.active) changed(content);
      else { tab.document.content = content; tab.editedAt = Date.now(); clearTimeout(draftTimer); draftTimer = setTimeout(() => { void persistDraft().catch(error => notify(String(error), true)); }, 600); }
    },
    selected: selected => { const previous = editor; editor = selected; writingTools?.switchEditor(previous); }, created: connectEditor,
    activate: id => { documents.activate(id); void persistDraft().catch(error => notify(String(error), true)); },
    dispatch: (command, payload) => { void dispatch(command, payload); }, notify });
  if (boot.session?.documents.length) {
    await documents.restore(boot.session, boot.transferred);
    if (boot.session.recovered) notify(t("已恢复上次会话的未保存文稿"));
    if (boot.initialDoc) await loadDocument(boot.initialDoc);
  } else if (boot.recovery) { await loadDocument(boot.recovery, true); notify(t("已恢复上次的未保存草稿")); }
  else await loadDocument(boot.initialDoc || current);
  ready = true;
  writingTools = new WritingTools(() => editor, changeSettings, () => busy || !ready);
  writingTools.apply(settings);
  installDiagramActions(notify);
  installMathCopyActions(() => settings, notify, () => busy);
  media = new MediaController(() => editor, { current: () => current, documentId: () => documentId, blocked: () => busy || !ready, autoUpload: () => settings.imageAutoUpload, upload: images => imageHostingDialog.uploadNew(images), save: () => save(), run: task => perform(task, true), notify });
  outline = new OutlinePanel(() => editor, () => busy || !ready);
  outline.apply(settings);
  formatMenu = new FormatMenu(() => editor, { blocked: () => busy || !ready, notify, settings: () => settings, changeSettings });
  formatMenu.apply(settings);
  shortcuts = new Shortcuts({ settings: () => settings, platform: () => platform, blocked: () => busy || !ready,
    dispatch: command => { void dispatch(command); }, save: async input => { settings = await window.moye.updateShortcut(input); applySettings(); } });
  for (const view of panes.views.values()) view.cleanup = connectEditor(view.editor, view.visual);
  applySettings(); updateStatus(); renderOutline(); renderFiles();
  window.moye.onCommand((command, payload) => { if (shortcuts?.allowsNative(command)) void dispatch(command, payload); });
  el('#shell').dataset.ready = 'true';
  setInterval(() => { void synchronizeWorkspace().catch(() => {}); }, 2500);
  setInterval(() => {
    if (busy || composing || lifecycleSettingsPending || document.querySelector('dialog[open]')) return;
    editor.flush();
    if (documents.snapshotsDue()) void dispatch('auto-snapshots');
    else if (documents.autosaveDue()) void dispatch('autosave');
  }, 1000);
  el('#editor-workspace').addEventListener('compositionstart', () => { composing = true; });
  el('#editor-workspace').addEventListener('compositionend', () => { composing = false; documents.touched(); });
  window.addEventListener('focus', () => { void synchronizeWorkspace().catch(() => {}); });
  if (boot.recovery && boot.initialDoc?.path) void dispatch('open-path', boot.initialDoc.path);
}
void start().catch(error => { if (el('#loading')) el('#loading').textContent = t("启动失败：{0}", error); notify(String(error), true); });

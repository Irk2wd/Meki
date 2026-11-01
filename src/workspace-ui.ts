import { ht, t } from '../electron/i18n.mjs';
import type { DocumentFile, RecentFile, RecentFolder, RecentFolderChange, SearchMatch, Workspace, WorkspaceEntry, WorkspaceRequest } from '../shared/meki';
import { icon } from './icons';
import { navigationRows, retainNavigationPath, navigationKey, type NavigationRow } from './workspace-navigation';
import './workspace.css';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const base = (name: string) => name.split(/[\\/]/).filter(Boolean).pop() || name;
export interface OpenLocation { path: string; anchor?: string; line?: number; column?: number }
interface Hooks {
  document(): DocumentFile;
  open(location: OpenLocation): Promise<void>;
  operation(request: WorkspaceRequest): Promise<void>;
  choose(): Promise<void>;
  openFolder(path: string): Promise<void>;
  refresh(): Promise<void>;
  notify(message: string, error?: boolean): void;
}

/** File navigation owns only UI state. File access and document replacement remain in the existing host flows. */
export class WorkspaceUI {
  private workspace: Workspace | null = null;
  private recent: RecentFile[] = [];
  private collapsed = new Set<string>();
  private sort = 'name';
  private selection = '';
  private currentPath: string | null = null;
  private contextPath = '';
  private pending: WorkspaceRequest | null = null;
  private pickerMode: 'quick' | 'search' = 'quick';
  private locations: OpenLocation[] = [];
  private pickedIndex = 0;
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private visibleRows: NavigationRow[] = [];
  private folders: RecentFolder[] = [];
  private folderBusy = false;
  private readonly panel = document.querySelector<HTMLElement>('#files-panel')!;
  private readonly dialog: HTMLDialogElement;
  private readonly picker: HTMLDialogElement;
  private readonly menu: HTMLElement;
  private readonly folderDialog: HTMLDialogElement;

  constructor(private hooks: Hooks) {
    this.panel.innerHTML = `<div class="workspace-tools"><button data-ws="new-file" title="${ht("新建文稿")}" aria-label="${ht("新建工作区文稿")}">${icon('plus',16)}</button><button data-ws="new-folder" title="${ht("新建文件夹")}" aria-label="${ht("新建文件夹")}">${icon('folder',16)}</button><button data-ws="quick" title="${ht("快速打开 Ctrl/⌘ K")}" aria-label="${ht("快速打开")}">${icon('open',16)}</button><button data-ws="search" title="${ht("搜索工作区 Ctrl/⌘ Shift K")}" aria-label="${ht("搜索工作区")}">${icon('search',16)}</button><button data-ws="refresh" title="${ht("刷新文件树")}" aria-label="${ht("刷新文件树")}">↻</button><button data-ws="root-menu" title="${ht("工作区操作")}" aria-label="${ht("工作区操作")}">⋯</button></div>
      <div class="file-filter">${icon('search',14)}<input id="file-filter" placeholder="${ht("筛选名称或路径")}" aria-label="${ht("搜索本地文件")}"></div>
      <div class="workspace-sort"><span id="workspace-count"></span><select id="workspace-sort" aria-label="${ht("文件排序")}"><option value="name">${ht("名称 ↑")}</option><option value="name-desc">${ht("名称 ↓")}</option><option value="modified">${ht("最近修改")}</option></select></div><div id="file-list" role="tree" aria-label="${ht("工作区文件树")}"></div>`;
    const host = document.createElement('div');
    host.innerHTML = `<div id="workspace-menu" class="workspace-menu" role="menu" hidden></div>
      <dialog id="workspace-dialog"><form id="workspace-form"><div class="dialog-heading"><h2 id="workspace-dialog-title">${ht("文件操作")}</h2><button type="button" data-ws-dialog-close aria-label="${ht("关闭文件操作")}">×</button></div><p id="workspace-operation-source"></p><label for="workspace-entry-name" class="field-label">${ht("名称")}</label><input id="workspace-entry-name" autocomplete="off" maxlength="240" required><label id="workspace-destination-label" class="field-label" for="workspace-destination">${ht("目标文件夹")}</label><select id="workspace-destination"></select><p class="workspace-hint" id="workspace-operation-hint"></p><p id="workspace-operation-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button" data-ws-dialog-close>${ht("取消")}</button><button class="primary-button" type="submit">${ht("确定")}</button></div></form></dialog>
      <dialog id="workspace-picker"><div class="dialog-heading"><h2 id="workspace-picker-title">${ht("快速打开")}</h2><button type="button" data-ws-picker-close aria-label="${ht("关闭查找窗口")}">×</button></div><div class="workspace-query"><input id="workspace-query" placeholder="${ht("输入名称或路径")}" autocomplete="off" aria-label="${ht("工作区查询")}"><label id="workspace-case-label" hidden><input id="workspace-case" type="checkbox">${ht("区分大小写")}</label></div><p id="workspace-search-status" role="status"></p><div id="workspace-results" role="listbox" aria-label="${ht("查找结果")}"></div></dialog>`;
    host.insertAdjacentHTML('beforeend', `<dialog id="recent-folders-dialog" aria-labelledby="recent-folders-title"><div class="dialog-heading"><h2 id="recent-folders-title">${ht("最近文件夹")}</h2><button type="button" data-folders="close" aria-label="${ht("关闭最近文件夹")}">×</button></div><p class="workspace-hint">${ht("固定常用位置；打开文件夹不会关闭已有文稿。")}</p><div id="recent-folder-list" role="list" aria-label="${ht("最近文件夹")}"></div><p id="recent-folder-status" role="status"></p><div class="dialog-actions"><button type="button" class="secondary-button" data-folders="clear">${ht("清除未固定记录")}</button><button type="button" class="primary-button" data-folders="choose">${ht("打开其他文件夹…")}</button></div></dialog>`);
    document.body.append(host);
    this.dialog = host.querySelector('#workspace-dialog')!;
    this.picker = host.querySelector('#workspace-picker')!;
    this.menu = host.querySelector('#workspace-menu')!;
    this.folderDialog = host.querySelector('#recent-folders-dialog')!;
    this.folderDialog.addEventListener('click', event => { void this.folderAction(event).catch(error => this.folderMessage(String(error))); });
    this.panel.addEventListener('click', event => { event.stopPropagation(); void this.click(event).catch(error => hooks.notify(String(error), true)); });
    this.panel.addEventListener('contextmenu', event => {
      const row = (event.target as Element).closest<HTMLElement>('[data-ws-path]');
      if (row && this.workspace) { event.preventDefault(); this.showMenu(row.dataset.wsPath!, event.clientX, event.clientY); }
    });
    this.panel.querySelector('#file-list')!.addEventListener('keydown', event => this.treeKey(event as KeyboardEvent));
    this.panel.querySelector('#file-list')!.addEventListener('focusin', event => {
      const row = (event.target as Element).closest<HTMLElement>('.workspace-tree-row');
      if (row) this.selectRow(row.dataset.wsPath!, false);
    });
    this.panel.querySelector('#file-filter')!.addEventListener('input', () => this.renderTree());
    this.panel.querySelector('#workspace-sort')!.addEventListener('change', event => { this.sort = (event.target as HTMLSelectElement).value; this.remember(); this.renderTree(); });
    this.menu.addEventListener('click', event => {
      const action = (event.target as Element).closest<HTMLElement>('[data-ws-menu]')?.dataset.wsMenu;
      this.menu.hidden = true;
      this.selectRow(this.contextPath, true);
      if (action) void this.menuAction(action).catch(error => hooks.notify(String(error), true));
    });
    document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target as Node)) this.menu.hidden = true; });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.menu.hidden) { this.menu.hidden = true; this.selectRow(this.contextPath, true); } });
    this.menu.addEventListener('keydown', event => {
      const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + items.length + (event.key === 'ArrowDown' ? 1 : -1)) % items.length]?.focus(); }
    });
    host.querySelectorAll('[data-ws-dialog-close]').forEach(button => button.addEventListener('click', () => this.dialog.close()));
    host.querySelector('[data-ws-picker-close]')!.addEventListener('click', () => this.picker.close());
    this.picker.addEventListener('close', () => { this.request++; clearTimeout(this.timer); });
    host.querySelector('#workspace-form')!.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.pending) return;
      const input = this.dialog.querySelector<HTMLInputElement>('#workspace-entry-name')!;
      const name = input.value.trim();
      if (!name) return;
      const request = { ...this.pending, name, destination: this.dialog.querySelector<HTMLSelectElement>('#workspace-destination')!.value };
      // Close before a native unsaved-changes dialog, so its result cannot leave a stale modal over the document.
      this.dialog.close();
      void hooks.operation(request);
    });
    host.querySelector('#workspace-query')!.addEventListener('input', () => this.queueQuery());
    host.querySelector('#workspace-case')!.addEventListener('change', () => this.queueQuery());
    host.querySelector('#workspace-results')!.addEventListener('click', event => {
      const row = (event.target as Element).closest<HTMLElement>('[data-ws-result]');
      if (row) this.openResult(Number(row.dataset.wsResult));
    });
    this.picker.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); this.pickedIndex = Math.max(0, Math.min(this.locations.length - 1, this.pickedIndex + (event.key === 'ArrowDown' ? 1 : -1))); this.highlight();
      } else if (event.key === 'Enter') { event.preventDefault(); this.openResult(this.pickedIndex); }
    });
  }

  render(workspace: Workspace | null, currentPath: string | null, recent: RecentFile[]) {
    if (workspace?.root !== this.workspace?.root) {
      this.collapsed.clear(); this.selection = ''; this.visibleRows = []; this.sort = 'name';
      try { const saved = JSON.parse(localStorage.getItem(`meki.workspace.${workspace?.root}`) || '{}'); if (Array.isArray(saved.collapsed)) this.collapsed = new Set(saved.collapsed.filter((v: unknown) => typeof v === 'string').slice(0,2000)); if (['name', 'name-desc', 'modified'].includes(saved.sort)) this.sort = saved.sort; } catch { /* View preferences are optional. */ }
    }
    this.workspace = workspace; this.recent = recent;
    if (currentPath !== this.currentPath && currentPath) {
      let parent = workspace?.tree?.find(entry => entry.path === currentPath)?.parentPath;
      while (parent && parent !== workspace?.root) { this.collapsed.delete(parent); parent = workspace?.tree?.find(entry => entry.path === parent)?.parentPath; }
      this.currentPath = currentPath; this.remember();
    }
    if (!this.selection) this.selection = currentPath || workspace?.root || '';
    document.querySelector('#workspace-name')!.textContent = workspace ? base(workspace.root) : t("个人写作空间");
    this.panel.querySelector<HTMLSelectElement>('#workspace-sort')!.value = this.sort;
    this.renderTree();
  }

  private remember() { if (this.workspace) try { localStorage.setItem(`meki.workspace.${this.workspace.root}`, JSON.stringify({ collapsed: [...this.collapsed], sort: this.sort })); } catch { /* Quota/full disk does not affect documents. */ } }
  remap(map: (path: string) => string | null | undefined) {
    const selected = map(this.selection); if (selected) this.selection = selected;
    this.collapsed = new Set([...this.collapsed].flatMap(path => { const next = map(path); return next === null ? [] : [next || path]; }));
    this.visibleRows = this.visibleRows.map(row => ({...row,entry:{...row.entry,path:map(row.entry.path) || row.entry.path,parentPath:map(row.entry.parentPath) || row.entry.parentPath}}));
    this.remember();
  }
  private renderTree() {
    const filter = this.panel.querySelector<HTMLInputElement>('#file-filter')!.value.toLocaleLowerCase();
    const list = this.panel.querySelector('#file-list')!;
    const hadFocus = list.contains(document.activeElement);
    const current = this.hooks.document().path;
    const entries: WorkspaceEntry[] = this.workspace?.tree || (this.workspace?.entries || this.recent.map(entry => ({ ...entry, relativePath: entry.name }))).map(entry => ({ ...entry, kind: 'file', parentPath: this.workspace?.root || '', modifiedAt: 0, size: 0 }));
    const rows = navigationRows(entries, this.workspace?.root || '', this.collapsed, this.sort, filter);
    this.selection = retainNavigationPath(this.selection, rows, this.visibleRows, current || ''); this.visibleRows = rows;
    const html = rows.map(({entry,level,position,size}) => `<div class="workspace-tree-row ${entry.path === current ? 'selected' : ''}" data-ws-path="${escape(entry.path)}" role="treeitem" tabindex="${entry.path === this.selection ? 0 : -1}" aria-label="${escape(entry.name)}" aria-selected="${entry.path === this.selection}" aria-level="${level}" aria-posinset="${position}" aria-setsize="${size}" ${entry.path === current ? 'aria-current="page"' : ''} ${entry.kind === 'directory' && !filter ? `aria-expanded="${!this.collapsed.has(entry.path)}"` : ''} style="--tree-depth:${level-1}"><button tabindex="-1" class="file-item" data-ws="${entry.kind === 'directory' ? 'toggle' : 'open'}" data-ws-path="${escape(entry.path)}" title="${escape(entry.relativePath)}">${icon(entry.kind === 'directory' ? this.collapsed.has(entry.path) ? 'chevron' : 'down' : 'page',14)}<span>${escape(entry.name)}${filter ? `<small>${escape(entry.relativePath)}</small>` : ''}</span></button>${this.workspace ? `<button tabindex="-1" class="workspace-row-menu" data-ws="menu" data-ws-path="${escape(entry.path)}" title="${ht("{0}的操作", escape(entry.name))}" aria-label="${ht("{0}的操作", escape(entry.name))}">⋯</button>` : ''}</div>`).join('');
    this.panel.querySelector('#workspace-count')!.textContent = `${this.workspace ? t("工作区") : t("最近")} · ${entries.filter(entry => entry.kind === 'file').length}${this.workspace?.truncated ? '+' : ''}`;
    list.innerHTML = html || `<div class="empty-nav"><span>${filter ? t("没有匹配的路径") : this.workspace ? t("这里还没有文稿") : t("打开一个文件夹开始整理")}</span><button class="text-button" data-ws="${this.workspace ? 'new-file' : 'choose'}">${this.workspace ? t("新建文稿 →") : t("选择文件夹 →")}</button></div>`;
    if (this.workspace?.truncated) list.insertAdjacentHTML('beforeend',`<p class="workspace-hint">${ht("仅显示前 500 份文稿 / 2,000 个节点。可打开较小的文件夹查看其余内容。")}</p>`);
    if (hadFocus) { if (this.selection) this.selectRow(this.selection, true); else list.querySelector<HTMLButtonElement>('button')?.focus(); }
  }

  private selectRow(path: string, focus: boolean) {
    const rows = [...this.panel.querySelectorAll<HTMLElement>('.workspace-tree-row')];
    // The root menu has no corresponding row; it must not remove the tree's only tab stop.
    if (!rows.some(row => row.dataset.wsPath === path)) { if (focus) rows.find(row => row.dataset.wsPath === this.selection)?.focus(); return; }
    this.selection = path;
    rows.forEach(row => {
      const selected = row.dataset.wsPath === path; row.tabIndex = selected ? 0 : -1; row.setAttribute('aria-selected', String(selected));
      if (selected && focus) { row.focus({preventScroll:true}); row.scrollIntoView({block:'nearest'}); }
    });
  }
  private togglePath(path: string) {
    const filter = this.panel.querySelector<HTMLInputElement>('#file-filter')!;
    if (filter.value) { filter.value = ''; this.collapsed.delete(path); }
    else if (this.collapsed.has(path)) this.collapsed.delete(path); else this.collapsed.add(path);
    this.remember(); this.renderTree();
  }
  private treeKey(event: KeyboardEvent) {
    const row = (event.target as Element).closest<HTMLElement>('.workspace-tree-row');
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    const path = row.dataset.wsPath!;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      if (!this.workspace) return;
      event.preventDefault(); const box = row.getBoundingClientRect(); this.showMenu(path, box.right, box.bottom); this.menu.querySelector<HTMLButtonElement>('button')?.focus(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' ', 'F2'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const result = navigationKey(this.visibleRows, path, event.key, this.collapsed, Boolean(this.panel.querySelector<HTMLInputElement>('#file-filter')!.value));
    if (result.focus) this.selectRow(result.focus, true);
    if (result.toggle) this.togglePath(result.toggle);
    if (result.open) void this.hooks.open({path:result.open});
    if (result.rename && this.workspace) this.showOperation({action:'rename',path:result.rename});
  }

  private selectedDirectory() {
    const entry = this.workspace?.tree?.find(entry => entry.path === this.selection);
    return entry?.kind === 'directory' ? entry.path : entry?.parentPath || this.workspace?.root || '';
  }
  private async click(event: MouseEvent) {
    const button = (event.target as Element).closest<HTMLElement>('[data-ws]'); if (!button) return;
    const action = button.dataset.ws!; const path = button.dataset.wsPath;
    if (path) this.selectRow(path, false);
    if (action === 'open' && path) await this.hooks.open({path});
    if (action === 'toggle' && path) this.togglePath(path);
    if (action === 'menu' || action === 'root-menu') { const box = button.getBoundingClientRect(); this.showMenu(path || this.workspace?.root || '', box.right, box.bottom); }
    if (action === 'new-file' || action === 'new-folder') this.showOperation({action:action === 'new-file' ? 'create-file' : 'create-folder',path:this.selectedDirectory()});
    if (action === 'quick' || action === 'search') this.showPicker(action);
    if (action === 'refresh') await this.hooks.refresh();
    if (action === 'choose') await this.hooks.choose();
  }
  private showMenu(path: string, x: number, y: number) {
    if (!this.workspace) { void this.hooks.choose(); return; }
    this.contextPath = path; this.selectRow(path, false);
    const directory = path === this.workspace.root || this.workspace.tree?.find(entry => entry.path === path)?.kind === 'directory';
    const items = [...(directory ? [['create-file',t("新建文稿")],['create-folder',t("新建文件夹")]] : [['open',t("打开")]]), ...(path !== this.workspace.root ? [['rename',t("重命名")],['copy',t("复制…")],['move',t("移动…")]] : []), ['reveal',t("在系统中显示")], ['copy-path',t("复制完整路径")], ...(path !== this.workspace.root ? [['trash',t("移入回收站…")]] : [['choose',t("切换工作区…")]])];
    this.menu.innerHTML = items.map(([action,label])=>`<button role="menuitem" data-ws-menu="${action}" class="${action==='trash'?'danger':''}">${label}</button>`).join('');
    this.menu.hidden = false; this.menu.style.left = `${Math.max(8,Math.min(x,innerWidth-185))}px`; this.menu.style.top = `${Math.max(8,Math.min(y,innerHeight-this.menu.offsetHeight-8))}px`;
  }
  private async menuAction(action: string) {
    if (action === 'open') return this.hooks.open({path:this.contextPath});
    if (action === 'choose') return this.hooks.choose();
    if (action === 'reveal' || action === 'copy-path') { await window.meki.workspacePathAction(action,this.contextPath); if(action==='copy-path') this.hooks.notify(t("已复制完整路径")); return; }
    if (action === 'trash') return this.hooks.operation({action,path:this.contextPath});
    this.showOperation({action:action as WorkspaceRequest['action'],path:this.contextPath});
  }
  private showOperation(request: WorkspaceRequest) {
    if (!this.workspace) { void this.hooks.choose(); return; }
    this.pending = request;
    const names = {'create-file':t("新建文稿"),'create-folder':t("新建文件夹"),rename:t("重命名"),copy:t("复制"),move:t("移动"),trash:t("移入回收站")};
    this.dialog.querySelector('#workspace-dialog-title')!.textContent = names[request.action];
    this.dialog.querySelector('#workspace-operation-source')!.textContent = request.path;
    const entry = this.workspace.tree?.find(entry => entry.path===request.path);
    const defaultName = request.action==='create-file'?t("未命名.md"):request.action==='create-folder'?t("新建文件夹"):request.action==='copy'?base(request.path).replace(/(\.[^.]+)?$/, t(" 副本$1")):base(request.path);
    this.dialog.querySelector<HTMLInputElement>('#workspace-entry-name')!.value = defaultName;
    const destination = this.dialog.querySelector<HTMLSelectElement>('#workspace-destination')!;
    destination.innerHTML = [{path:this.workspace.root,relativePath:t("工作区根目录")},...(this.workspace.tree || []).filter(entry=>entry.kind==='directory')].map(entry=>`<option value="${escape(entry.path)}">${escape(entry.relativePath)}</option>`).join('');
    destination.value = entry?.parentPath || this.workspace.root;
    destination.hidden = !['copy','move'].includes(request.action);
    this.dialog.querySelector<HTMLElement>('#workspace-destination-label')!.hidden = destination.hidden;
    this.dialog.querySelector('#workspace-operation-error')!.textContent = '';
    this.dialog.querySelector('#workspace-operation-hint')!.textContent = request.action==='copy'?t("复制磁盘上的内容，未保存的编辑仍留在当前文稿。目录复制包含其中的资源文件。"):request.action==='move'||request.action==='rename'?t("不会自动改写 Markdown 中的相对链接。移动文稿时，请同时整理它引用的资源；移动整个文件夹可保留内部相对关系。"):t("同名文件不会被覆盖。");
    this.dialog.showModal(); const input = this.dialog.querySelector<HTMLInputElement>('#workspace-entry-name')!; input.focus(); input.select();
  }

  async showFolders() {
    this.folderMessage(t("正在读取最近位置…"));
    if (!this.folderDialog.open) this.folderDialog.showModal();
    try { this.folders = await window.meki.listRecentFolders(); this.renderFolders(); this.folderMessage(t("最多保留 20 个位置，可固定 10 个。清除记录不会删除文件。")); }
    catch (error) { this.folderMessage(String(error)); }
  }
  private folderMessage(message: string) { this.folderDialog.querySelector('#recent-folder-status')!.textContent = message.replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, ''); }
  private renderFolders() {
    this.folderDialog.querySelector('#recent-folder-list')!.innerHTML = this.folders.map(folder => `<div class="recent-folder-row" role="listitem" data-folder-path="${escape(folder.path)}"><button class="recent-folder-open" data-folders="open" title="${escape(folder.path)}"><strong>${folder.pinned ? '★ ' : ''}${escape(folder.name)}</strong><small>${escape(folder.path)}</small></button><button class="recent-folder-pin" data-folders="${folder.pinned ? 'unpin' : 'pin'}" aria-label="${folder.pinned ? t("取消固定") : t("固定")} ${escape(folder.name)}" aria-pressed="${folder.pinned}">${folder.pinned ? '★' : '☆'}</button><button data-folders="remove" aria-label="${ht("从最近位置移除 {0}", escape(folder.name))}" title="${ht("从记录中移除")}">×</button></div>`).join('') || `<p class="empty-nav">${ht("尚无最近文件夹。选择一个目录开始整理。")}</p>`;
    this.folderDialog.querySelector<HTMLButtonElement>('[data-folders="clear"]')!.disabled = !this.folders.some(folder => !folder.pinned);
  }
  private async folderAction(event: MouseEvent) {
    const button = (event.target as Element).closest<HTMLElement>('[data-folders]');
    if (!button || this.folderBusy) return;
    const action = button.dataset.folders!;
    if (action === 'close') { this.folderDialog.close(); return; }
    if (action === 'choose') { this.folderDialog.close(); await this.hooks.choose(); return; }
    const path = button.closest<HTMLElement>('[data-folder-path]')?.dataset.folderPath;
    this.folderBusy = true; this.folderDialog.setAttribute('aria-busy', 'true');
    try {
      if (action === 'open' && path) { await this.hooks.openFolder(path); this.folderDialog.close(); }
      else {
        const oldIndex = this.folders.findIndex(folder => folder.path === path);
        this.folders = await window.meki.changeRecentFolders({action:action as RecentFolderChange['action'], ...(path ? {path} : {})});
        this.renderFolders(); this.folderMessage(action === 'clear' ? t("已清除未固定记录，文件与当前工作区保持不变。") : action === 'remove' ? t("已从记录中移除，文件保持不变。") : t("已更新固定位置。"));
        const rows = [...this.folderDialog.querySelectorAll<HTMLElement>('[data-folder-path]')];
        const row = rows.find(row => row.dataset.folderPath === path) || rows[Math.max(0, Math.min(rows.length - 1, oldIndex))];
        (row?.querySelector<HTMLButtonElement>(action === 'pin' || action === 'unpin' ? '.recent-folder-pin' : '.recent-folder-open') || this.folderDialog.querySelector<HTMLButtonElement>('[data-folders="choose"]'))?.focus();
      }
    } finally { this.folderBusy = false; this.folderDialog.removeAttribute('aria-busy'); }
  }

  showPicker(mode: 'quick' | 'search') {
    this.pickerMode = mode; this.request++; this.locations=[];
    this.picker.querySelector('#workspace-picker-title')!.textContent = mode==='quick'?t("快速打开"):t("搜索工作区内容");
    this.picker.querySelector<HTMLElement>('#workspace-case-label')!.hidden = mode==='quick';
    const query = this.picker.querySelector<HTMLInputElement>('#workspace-query')!; query.value=''; query.placeholder=mode==='quick'?t("输入文件名或路径，支持不连续字符"):t("输入文稿中的文字");
    if(!this.picker.open) this.picker.showModal(); query.focus(); this.queueQuery();
  }
  private queueQuery() {
    clearTimeout(this.timer); this.request++;
    // Quick-open is local and synchronous: Enter must use the just-typed query.
    // Invalidate debounced content results immediately so stale rows cannot open.
    this.locations=[];
    this.picker.querySelector('#workspace-results')!.innerHTML='';
    if (this.pickerMode === 'quick') void this.query(this.request);
    else this.timer=setTimeout(()=>void this.query(this.request),180);
  }
  private async query(request: number) {
    const query = this.picker.querySelector<HTMLInputElement>('#workspace-query')!.value.trim();
    const status = this.picker.querySelector('#workspace-search-status')!;
    this.pickedIndex=0;
    if(this.pickerMode==='quick') {
      const files = this.workspace?.entries || this.recent.map(entry=>({...entry,relativePath:entry.name}));
      const score = (file: string) => { const value=file.toLocaleLowerCase(),needle=query.toLocaleLowerCase(); if(value.includes(needle))return value.indexOf(needle); let last=-1,total=50; for(const letter of needle){const next=value.indexOf(letter,last+1);if(next<0)return Infinity;total+=next-last;last=next;}return total; };
      const matched=files.map(file=>({file,score:score(file.relativePath)})).filter(item=>Number.isFinite(item.score)).sort((a,b)=>a.score-b.score).slice(0,100).map(item=>item.file);
      this.locations=matched.map(file=>({path:file.path})); status.textContent=t("{0} 个结果 · ↑↓ 选择，Enter 打开", matched.length);
      this.picker.querySelector('#workspace-results')!.innerHTML=matched.map((file,index)=>`<button role="option" data-ws-result="${index}"><strong>${escape(file.name)}</strong><small>${escape(file.relativePath)}</small></button>`).join('');
    } else {
      if(!this.workspace || !query) {this.locations=[];this.picker.querySelector('#workspace-results')!.innerHTML='';status.textContent=this.workspace?t("搜索磁盘中已保存的文稿；未保存修改不在结果中。"):t("请先打开工作区文件夹。");return;}
      status.textContent=t("正在搜索…");
      this.locations=[]; this.picker.querySelector('#workspace-results')!.innerHTML='';
      try {
        const result=await window.meki.searchWorkspace(query,this.picker.querySelector<HTMLInputElement>('#workspace-case')!.checked);
        if(request!==this.request || !this.picker.open)return;
        this.locations=result.matches.map(match=>({path:match.path,line:match.line,column:match.column}));
        status.textContent=t("{0} 处匹配 · 已查 {1} 份文稿{2}{3}", result.matches.length, result.scanned, result.skipped?t(" · 跳过 {0} 份不可读或过大文件", result.skipped):'', result.truncated?t(" · 已达到扫描或结果上限"):'');
        this.picker.querySelector('#workspace-results')!.innerHTML=result.matches.map((match: SearchMatch,index)=>`<button role="option" data-ws-result="${index}"><strong>${escape(match.relativePath)} : ${match.line}</strong><small>${escape(match.text)}</small></button>`).join('');
      }catch(error){if(request===this.request)status.textContent=String(error);}
    }
    this.highlight();
  }
  private highlight() {
    this.picker.querySelectorAll<HTMLElement>('[data-ws-result]').forEach((row,index)=>{const active=index===this.pickedIndex;row.classList.toggle('active',active);row.setAttribute('aria-selected',String(active));if(active)row.scrollIntoView({block:'nearest'});});
  }
  private openResult(index: number) {const location=this.locations[index];if(!location)return;this.picker.close();void this.hooks.open(location);}
}

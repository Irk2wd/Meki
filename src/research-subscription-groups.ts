import { ht, t } from '../electron/i18n.mjs';
import type { PreviewAccount, PreviewConnection } from '../shared/research-preview';
import { escapeResearch as esc } from './research-tools';
import { icon } from './icons';
import './research-subscription-groups.css';

const errorText = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');

export class SubscriptionGroups {
  private dialog = document.createElement('dialog');
  private accounts: PreviewAccount[] = [];
  private account?: PreviewAccount;
  private group = '';
  private checked = new Set<string>();
  private session = 0;

  constructor(private openProject: (c: PreviewConnection) => Promise<void>,
    private copiesRemoved: (ids: string[]) => Promise<void>) {
    this.dialog.id = 'research-subscription-groups';
    this.dialog.setAttribute('aria-labelledby', 'subscription-groups-title');
    this.dialog.addEventListener('close', () => { this.session++; this.dialog.replaceChildren(); });
    document.body.append(this.dialog);
  }

  async show(accountId?: string) {
    const accounts = await window.meki.previewAccounts();
    this.accounts = accounts;
    this.select(accounts.find(a => a.id === accountId) || accounts[0]);
    if (!this.dialog.open) this.dialog.showModal();
    if (this.account) {
      this.render();
      void this.refresh();
    } else await this.loginForm();
  }

  private select(account?: PreviewAccount) {
    this.session++;
    this.account = account;
    this.group = '';
    this.checked.clear();
  }

  private header(title: string) {
    return `<header class="dialog-heading"><h2 id="subscription-groups-title">${esc(title)}</h2>
      <button type="button" class="icon-button" data-groups-close aria-label="${ht("关闭")}">${icon('close',16)}</button></header>`;
  }

  private wireClose() {
    this.dialog.querySelector<HTMLButtonElement>('[data-groups-close]')!.onclick = () => this.dialog.close();
  }

  private async loginForm(edit?: PreviewAccount) {
    const seq = ++this.session;
    const direct = edit ? [] : (await window.meki.previewSubscriptions()).filter(c => c.username && !c.accountId);
    if (!this.dialog.open || seq !== this.session) return;
    this.dialog.innerHTML = `${this.header(t("登录订阅账号"))}
      <p class="groups-hint">${ht("登录后可浏览已加入的订阅组，勾选项目后才会下载快照。")}</p>
      <form class="groups-login"><label>${ht("订阅服务器地址")}<input type="url" name="url" required autofocus placeholder="https://…" value="${esc(edit?.url || '')}"></label>
      <div class="remote-login"><label>${ht("用户名")}<input name="username" autocomplete="username" required ${edit ? 'readonly' : ''} value="${esc(edit?.username || '')}"></label>
      <label>${ht("密码")}<input name="password" type="password" autocomplete="current-password" ${edit ? 'placeholder="' + ht("沿用已保存的密码") + '"' : 'required'}></label></div>
      ${direct.length ? `<div class="groups-saved"><span>${ht("使用本机已保存的项目账号")}</span>${direct.map(c =>
        `<button type="button" class="secondary-button" data-upgrade="${esc(c.id)}">${esc(c.username)} · ${esc(c.title)}</button>`).join('')}</div>` : ''}
      <p role="status" aria-live="polite"></p><footer>${edit ? `<button type="button" class="text-button" data-logout>${ht("退出账号并移除本机副本")}</button>` : ''}
        ${this.account ? `<button type="button" class="secondary-button" data-back>${ht("返回")}</button>` : ''}
        <button type="submit" class="primary-button">${ht("连接订阅组")}</button></footer></form>`;
    this.wireClose();
    const form = this.dialog.querySelector('form')!;
    const connect = (action: () => Promise<PreviewAccount>) => this.work(async () => {
      const account = await action();
      const accounts = await window.meki.previewAccounts();
      if (this.session !== seq) return;
      this.accounts = accounts;
      this.select(account);
      this.render();
    }, t("正在读取项目清单…"));
    form.onsubmit = event => {
      event.preventDefault();
      const data = new FormData(form);
      void connect(() => window.meki.previewAccountLogin({url:String(data.get('url')).trim(),
        username:String(data.get('username')).trim(), password:String(data.get('password') || '') || undefined},edit?.id));
    };
    form.onclick = event => {
      const button = (event.target as Element).closest('button');
      if (!button) return;
      if (button.hasAttribute('data-back')) { this.session++; this.render(); }
      if (button.dataset.upgrade) void connect(() => window.meki.previewAccountUpgrade(button.dataset.upgrade!));
      if (button.hasAttribute('data-logout') && edit) void this.work(async () => {
        await window.meki.previewAccountLogout(edit.id);
        await this.copiesRemoved(edit.selected.map(copy => copy.id));
        if (seq === this.session) await this.show();
      });
    };
  }

  private status(message: string) {
    const el = this.dialog.querySelector('[role=status]');
    if (el) el.textContent = message;
  }
  private async work(action: () => Promise<void>, busy = '') {
    const seq = this.session;
    const controls = [...this.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input:enabled,select:enabled,button:enabled:not([data-groups-close])')];
    controls.forEach(el => el.disabled = true);
    this.status(busy);
    try { await action(); }
    catch (error) { if (seq === this.session) this.status(errorText(error)); }
    finally { controls.forEach(el => el.disabled = false); }
  }

  private async refresh() {
    const id = this.account?.id;
    if (!id) return;
    const seq = ++this.session;
    this.status(t("正在读取项目清单…"));
    let message = '';
    try { await window.meki.previewAccountRefresh(id); }
    catch (error) { message = errorText(error); }
    await this.reload(id, seq, message);
  }
  private async reload(id: string, seq: number, message = '') {
    const accounts = await window.meki.previewAccounts();
    if (this.session !== seq || !this.dialog.open) return;
    this.accounts = accounts;
    this.account = accounts.find(a => a.id === id);
    if (!this.account) { await this.show(); return; }
    const {catalog} = this.account;
    if (!catalog.groups.some(g => g.id === this.group)) this.group = '';
    const visible = new Set(catalog.projects.map(p => p.id));
    this.checked = new Set([...this.checked].filter(p => visible.has(p)));
    this.render(message);
  }

  private render(message = '') {
    const account = this.account!;
    const {catalog, selected} = account;
    const groups = catalog.groups;
    const members = groups.find(g => g.id === this.group);
    const projects = catalog.projects.filter(p => !members || members.projects.includes(p.id));
    const local = new Map(selected.map(s => [s.projectId,s]));
    const rows = projects.map(p => {
      const copy = local.get(p.id);
      const memberships = groups.filter(g => g.projects.includes(p.id)).map(g => g.title).join(' · ');
      return `<li data-group-project="${esc(p.id)}"><label class="group-project-name">
        <input type="checkbox" value="${esc(p.id)}" ${this.checked.has(p.id) ? 'checked' : ''}><span><strong>${esc(p.title)}</strong><small>${esc(memberships)}</small></span></label>
        <div class="group-project-actions">${copy ? `<small>${ht("已拉取")}</small><button type="button" class="secondary-button" data-open-copy="${esc(copy.id)}">${ht("打开")}</button>
        <details><summary aria-label="${ht("本机副本设置")}" title="${ht("本机副本设置")}">${icon('sliders',16)}</summary><div>
          <label><input type="checkbox" data-auto="${esc(copy.id)}" ${copy.auto ? 'checked' : ''}>${ht("阅读时自动更新")}</label>
          <button type="button" class="text-button" data-remove-copy="${esc(copy.id)}">${ht("移除本机副本")}</button></div></details>`
          : `<small>${ht("仅云端")}</small>`}</div></li>`;
    }).join('');
    this.dialog.innerHTML = `${this.header(t("订阅组"))}<div class="groups-account">
      ${this.accounts.length > 1 ? `<select aria-label="${ht("订阅账号")}" data-account>${this.accounts.map(a => `<option value="${esc(a.id)}" ${a.id === account.id ? 'selected' : ''}>${esc(a.catalog.library.title)} · ${esc(a.username)}</option>`).join('')}</select>`
        : `<span><strong>${esc(catalog.library.title)}</strong> · ${esc(account.username)}</span>`}
      <button type="button" class="text-button" data-account-edit>${ht("账号设置")}</button>
      <button type="button" class="text-button" data-account-add>${ht("添加账号")}</button></div>
      <div class="groups-filter"><select data-group aria-label="${ht("订阅组")}"><option value="">${ht("全部订阅组")} (${catalog.projects.length})</option>
        ${groups.map(g => `<option value="${esc(g.id)}" ${this.group === g.id ? 'selected' : ''}>${esc(g.title)} (${g.projects.length})</option>`).join('')}</select>
        <button type="button" class="text-button" data-refresh-list>${ht("刷新清单")}</button></div>
      <ul class="group-project-list">${rows}</ul>${rows ? '' : `<p class="groups-hint">${account.needsLogin ? ht("请重新登录订阅账号。") : ht("当前订阅组还没有可供拉取的项目。")}</p>`}
      <p role="status" aria-live="polite">${esc(message)}</p><footer>
      <small>${ht("仅下载勾选项目的快照和缩略图。")}</small><button type="button" class="primary-button" data-pull>${ht("拉取所选项目")} (${this.checked.size})</button></footer>`;
    this.wireClose();
    const pull = this.dialog.querySelector<HTMLButtonElement>('[data-pull]')!;
    pull.disabled = !this.checked.size;
    const accountField = this.dialog.querySelector<HTMLSelectElement>('[data-account]');
    if (accountField) accountField.onchange = () => {
      this.select(this.accounts.find(a => a.id === accountField.value)); this.render(); void this.refresh();
    };
    this.dialog.querySelector<HTMLSelectElement>('[data-group]')!.onchange = event => {
      this.group = (event.target as HTMLSelectElement).value; this.render();
    };
    this.dialog.querySelector<HTMLButtonElement>('[data-refresh-list]')!.onclick = () => { void this.refresh(); };
    this.dialog.querySelector<HTMLButtonElement>('[data-account-edit]')!.onclick = () => { void this.loginForm(account); };
    this.dialog.querySelector<HTMLButtonElement>('[data-account-add]')!.onclick = () => { void this.loginForm(); };
    const list = this.dialog.querySelector('ul')!;
    list.onchange = event => {
      const check = event.target;
      if (!(check instanceof HTMLInputElement)) return;
      if (check.dataset.auto) {
        const seq = ++this.session;
        void this.work(async () => {
          try { await window.meki.previewAccountAuto(check.dataset.auto!,check.checked); }
          finally { await this.reload(account.id,seq); }
        });
        return;
      }
      if (check.checked) this.checked.add(check.value); else this.checked.delete(check.value);
      pull.disabled = !this.checked.size;
      pull.textContent = t("拉取所选项目") + ' (' + this.checked.size + ')';
    };
    list.onclick = event => {
      const button = (event.target as Element).closest('button');
      if (!button) return;
      const seq = ++this.session;
      void this.work(async () => {
        if (button.dataset.openCopy) {
          const reader = (await window.meki.previewSubscriptions()).find(c => c.id === button.dataset.openCopy);
          if (seq !== this.session) return;
          if (reader) { this.dialog.close(); await this.openProject(reader); }
          else await this.reload(account.id,seq);
        } else if (button.dataset.removeCopy) {
          await window.meki.previewUnsubscribe(button.dataset.removeCopy);
          await this.copiesRemoved([button.dataset.removeCopy]);
          await this.reload(account.id,seq);
        }
      });
    };
    pull.onclick = () => {
      const seq = ++this.session;
      const ids = [...this.checked];
      void this.work(async () => {
        let result = '';
        try {
          const {pulled,errors} = await window.meki.previewAccountPull(account.id,ids);
          if (seq !== this.session) return;
          pulled.forEach(p => this.checked.delete(p));
          result = [t("已拉取 {0} 个项目",pulled.length),...errors.map(e => (catalog.projects.find(p => p.id === e.projectId)?.title || e.projectId) + ' · ' + e.message)].join('\n');
        } catch (error) { result = errorText(error); }
        await this.reload(account.id,seq,result);
      },t("正在拉取所选项目…"));
    };
  }
}

import { ht, t } from '../electron/i18n.mjs';
import type { UpdateState } from '../shared/updates';
import './updates.css';

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export class UpdateDialog {
  private dialog = document.createElement('dialog');
  private state: UpdateState | null = null;
  private pending = false;
  private notice = document.createElement('aside');
  private dismissedVersion: string | null = null;
  constructor(private apply: () => Promise<void>) {
    this.dialog.id = 'update-dialog'; this.dialog.setAttribute('aria-labelledby', 'update-title');
    this.dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">${ht("MEKI · 更新")}</span><h2 id="update-title">${ht("让Meki保持新鲜")}</h2></div><button type="button" data-update="close" class="icon-button" aria-label="${ht("关闭更新窗口")}">×</button></div>
      <p id="update-version"></p><p id="update-message" role="status" aria-live="polite"></p>
      <div id="update-progress-row" hidden><progress id="update-progress" max="100" value="0" aria-label="${ht("更新下载进度")}"></progress><span id="update-progress-text"></span></div>
      <details id="update-release-notes" hidden><summary>${ht("版本说明")}</summary><pre id="update-notes"></pre></details>
      <p class="update-note">${ht("轻量更新只下载程序代码。升级运行环境时才需要完整安装器；macOS 安装器打开后需拖入“应用程序”。")}</p>
      <label class="update-automatic"><input type="checkbox" id="automatic-updates">${ht("自动检查更新并提醒")}</label>
      <p class="update-note">${ht("启动后检查一次，此后每 6 小时检查。不会自动下载或安装。")}</p>
      <div class="update-actions"><button type="button" data-update="check">${ht("检查更新")}</button><button type="button" data-update="cancel" hidden>${ht("取消下载")}</button><button type="button" data-update="download" class="primary-button" hidden>${ht("下载更新")}</button><button type="button" data-update="apply" class="primary-button" hidden>${ht("重启并更新")}</button></div>`;
    document.body.append(this.dialog);
    this.notice.id = 'update-notice'; this.notice.hidden = true;
    this.notice.setAttribute('role', 'status'); this.notice.setAttribute('aria-live', 'polite');
    this.notice.innerHTML = `<div class="update-notice-heading"><strong id="update-notice-title"></strong><button type="button" data-update-notice="dismiss" aria-label="${ht("关闭此版本提醒")}" title="${ht("关闭此版本提醒")}">×</button></div><p>${ht("有新版本可用，查看说明后再决定更新。")}</p><button type="button" data-update-notice="view" class="primary-button">${ht("查看更新")}</button>`;
    document.body.append(this.notice);
    this.notice.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-update-notice]')?.dataset.updateNotice;
      if (!action) return;
      this.dismissNotice();
      if (action === 'view') void this.open();
    });
    this.element<HTMLInputElement>('#automatic-updates').addEventListener('change', event => {
      const input = event.target as HTMLInputElement, enabled = input.checked; input.disabled = true;
      void window.meki.setAutomaticUpdates(enabled).then(state => this.render(state)).catch(error => {
        if (this.state) this.element<HTMLInputElement>('#automatic-updates').checked = this.state.automatic;
        this.element('#update-message').textContent = String(error);
      }).finally(() => { input.disabled = false; });
    });
    this.dialog.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-update]')?.dataset.update;
      if (action) void this.action(action);
    });
    window.meki.onUpdate(state => this.render(state));
    window.addEventListener('focus', () => this.renderNotice());
    document.addEventListener('visibilitychange', () => this.renderNotice());
    document.addEventListener('close', () => this.renderNotice(), true);
    void window.meki.updateState().then(state => this.render(state)).catch(() => {});
  }
  private dismissNotice() {
    const version = this.state?.notificationVersion;
    if (!version || version === this.dismissedVersion) return;
    this.dismissedVersion = version; this.notice.hidden = true;
    void window.meki.dismissUpdateNotification(version).catch(() => {});
  }
  private renderNotice() {
    const version = this.state?.notificationVersion;
    if (this.dialog.open) this.dismissNotice();
    this.notice.hidden = !version || version === this.dismissedVersion || this.state?.status !== 'available' ||
      !document.hasFocus() || document.visibilityState === 'hidden' || !!document.querySelector('dialog[open]');
    if (version) this.notice.querySelector('#update-notice-title')!.textContent = t("Meki {0} 已发布", version);
  }
  private element<T extends HTMLElement = HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }
  async open() {
    if (!this.dialog.open) this.dialog.showModal();
    try { this.render(await window.meki.updateState()); }
    catch (error) { this.element('#update-message').textContent = String(error); }
  }
  private render(state: UpdateState) {
    this.state = state;
    this.element<HTMLInputElement>('#automatic-updates').checked = state.automatic;
    this.renderNotice();
    const busy = this.pending || ['checking', 'downloading'].includes(state.status);
    this.element('#update-version').textContent = t("当前版本 {0}{1}", state.currentVersion, state.latestVersion ? t(" · 最新版本 {0}", state.latestVersion) : '');
    this.element('#update-message').textContent = state.message;
    this.element('#update-message').classList.toggle('error', state.status === 'error');
    this.element<HTMLButtonElement>('[data-update="check"]').disabled = busy;
    this.element('[data-update="download"]').hidden = !['available', 'error'].includes(state.status) || !state.kind;
    this.element<HTMLButtonElement>('[data-update="download"]').disabled = busy;
    this.element('[data-update="download"]').textContent = t("下载{0} · {1}", state.kind === 'installer' ? t("安装器") : t("轻量更新"), size(state.total));
    this.element('[data-update="cancel"]').hidden = !['checking', 'downloading'].includes(state.status);
    this.element('[data-update="apply"]').hidden = state.status !== 'ready';
    this.element<HTMLButtonElement>('[data-update="apply"]').disabled = this.pending;
    this.element('[data-update="apply"]').textContent = state.kind === 'installer' ? t("打开安装器") : t("重启并更新");
    this.element('#update-progress-row').hidden = state.status !== 'downloading';
    this.element<HTMLProgressElement>('#update-progress').value = state.total ? state.downloaded / state.total * 100 : 0;
    this.element('#update-progress-text').textContent = `${size(state.downloaded)} / ${size(state.total)}`;
    this.element('#update-release-notes').hidden = !state.notes;
    this.element('#update-notes').textContent = state.notes;
  }
  private async action(action: string) {
    if (action === 'close') { this.dialog.close(); return; }
    if (action === 'cancel') { await window.meki.cancelUpdate(); return; }
    if (this.pending) return;
    this.pending = true; if (this.state) this.render(this.state);
    try {
      if (action === 'check') this.render(await window.meki.checkUpdate());
      if (action === 'download') this.render(await window.meki.downloadUpdate());
      if (action === 'apply') await this.apply();
    } catch (error) {
      const message = String(error).replace(/^Error: /, '');
      if (this.state) this.state = { ...this.state, message }; else this.element('#update-message').textContent = message;
    }
    finally { this.pending = false; if (this.state) this.render(this.state); }
  }
}

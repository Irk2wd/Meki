import { ht, t } from '../electron/i18n.mjs';
import { logo } from './icons';
import { author } from '../package.json';
import './about.css';

export class AboutDialog {
  private dialog = document.createElement('dialog');
  private notices: Promise<void> | undefined;

  constructor(version: string, private updates: () => Promise<void>) {
    this.dialog.id = 'about-dialog';
    this.dialog.setAttribute('aria-labelledby', 'about-title');
    this.dialog.innerHTML = `<div class="dialog-heading">
      <div class="about-brand"><span class="about-mark" aria-hidden="true">${logo}</span><div><span class="eyebrow">${ht("MEKI")}</span><h2 id="about-title">${ht("关于 Meki")}</h2></div></div>
      <button type="button" data-about="close" class="icon-button" aria-label="${ht("关闭关于窗口")}" autofocus>×</button>
    </div>
    <p class="about-description">${ht("安静写作，让想法留在你手中。")}</p>
    <dl class="about-info"><dt>${ht("当前版本")}</dt><dd id="about-version"></dd><dt>${ht("开发者")}</dt><dd id="about-developer"></dd><dt>${ht("项目主页")}</dt><dd><a href="https://github.com/Irk2wd/Meki" data-about="project">Irk2wd / Meki ↗</a></dd></dl>
    <p class="about-note">${ht("开源的跨平台 Markdown 编辑器，支持本地文件、即时预览、公式与图表。")}</p>
    <details id="about-notices"><summary>${ht("开源组件声明")}</summary><p class="about-note">${ht("感谢开源社区。以下声明包含应用依赖和构建工具；Electron / Chromium 的完整许可随安装包附带。")}</p><pre id="about-notices-text" tabindex="0" aria-label="${ht("开源组件许可正文")}"></pre></details>
    <p id="about-feedback" role="status" aria-live="polite"></p>
    <div class="about-actions"><button type="button" class="primary-button" data-about="updates">${ht("检查更新…")}</button></div>`;
    this.element('#about-version').textContent = version;
    this.element('#about-developer').textContent = author;
    this.element<HTMLDetailsElement>('#about-notices').addEventListener('toggle', () => {
      if (this.element<HTMLDetailsElement>('#about-notices').open) void this.loadNotices();
    });
    this.dialog.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-about]')?.dataset.about;
      if (action) { event.preventDefault(); void this.action(action); }
    });
    document.body.append(this.dialog);
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }

  open() {
    this.element('#about-feedback').textContent = '';
    if (!this.dialog.open) this.dialog.showModal();
  }

  private async loadNotices() {
    if (this.notices) return this.notices;
    const content = this.element('#about-notices-text');
    content.textContent = t("正在加载本地声明…");
    this.notices = import('../THIRD_PARTY_NOTICES.txt?raw').then(module => {
      content.textContent = module.default;
    }).catch(() => {
      content.textContent = t("无法读取开源组件声明，请收起后重试。安装包中也附有 THIRD_PARTY_NOTICES.txt。");
      this.notices = undefined;
    });
    return this.notices;
  }

  private async action(action: string) {
    if (action === 'close') { this.dialog.close(); return; }
    try {
      if (action === 'project') await window.moye.openExternal('https://github.com/Irk2wd/Meki');
      if (action === 'updates') { this.dialog.close(); await this.updates(); }
    } catch (error) {
      this.element('#about-feedback').textContent = t("操作未完成：{0}", String(error).replace(/^Error: /, ''));
      if (!this.dialog.open) this.dialog.showModal();
    }
  }
}

import { getLocale, ht, t } from '../electron/i18n.mjs';
import type { PreviewConnection, PreviewLogin } from '../shared/research-preview';
import type { ResearchSnapshot } from '../shared/research';
import { escapeResearch as esc } from './research-tools';
import { icon } from './icons';
import './research-remote-preview.css';

const message = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');
const time = (value: string) => new Date(value).toLocaleString(getLocale(), {dateStyle:'medium',timeStyle:'short'});
const close = () => `<button type="button" class="icon-button" data-remote-close aria-label="${ht("关闭")}">${icon('close',16)}</button>`;
const loginFields = (c?: PreviewConnection | null) => `<label>${ht("WebDAV 项目目录地址")}<input name="url" type="url" required placeholder="https://dav.example.org/projects/…" value="${esc(c?.url || '')}"></label>
  <div class="remote-login"><label>${ht("用户名")}<input name="username" autocomplete="off" value="${esc(c?.username || '')}"></label>
  <label>${ht("密码")}<input name="password" type="password" autocomplete="new-password" placeholder="${c?.username ? ht("沿用已保存的密码") : ''}"></label></div>`;
const readLogin = (data: FormData): PreviewLogin => ({url:String(data.get('url')).trim(),username:String(data.get('username')), password:String(data.get('password') || '') || undefined});

export class RemotePreviewUI {
  private settings = document.createElement('dialog');

  constructor(private openProject: (c: PreviewConnection) => Promise<void>, private removed: (id: string) => Promise<void>) {
    this.settings.id = 'research-remote-settings';
    this.settings.setAttribute('aria-labelledby', 'research-remote-settings-title');
    this.settings.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-remote-close]')) this.settings.close();
    });
    document.body.append(this.settings);
  }

  async publisher(state: ResearchSnapshot) {
    const config = await window.meki.previewPublisher(state.root);
    const pins = new Set(config?.pinned);
    const choices = state.records.filter(e => !e.record.comparison).sort((a,b) => b.record.date.localeCompare(a.record.date));
    this.settings.innerHTML = `<form><header class="dialog-heading"><h2 id="research-remote-settings-title">${ht("发布远程预览")}</h2>${close()}</header>
      <p>${ht("发布阶段进展、总结摘录和对比缩略图。勾选的记录会附上完整正文。")}</p>
      ${loginFields(config)}<label class="remote-check"><input type="checkbox" name="auto" ${config?.auto !== false ? 'checked' : ''}>${ht("mekiR 运行时自动发布变更")}</label>
      <details data-pin-picker><summary>${ht("附上精选记录正文")} <span data-pin-count></span></summary>
        <input type="search" aria-label="${ht("筛选记录标题")}" placeholder="${ht("筛选记录标题")}" data-pin-search><div class="remote-pins"></div></details>
      <p role="status">${esc(config?.error || (config?.publishedAt ? t("最近发布于 {0}",time(config.publishedAt)) : ''))}</p>
      <footer>${config?.auto ? `<button type="button" class="text-button" data-pause>${ht("暂停自动发布")}</button>` : ''}<button class="primary-button" type="submit">${ht("保存并发布")}</button></footer></form>`;
    const pinPicker = this.settings.querySelector<HTMLDetailsElement>('[data-pin-picker]')!;
    const search = pinPicker.querySelector<HTMLInputElement>('[data-pin-search]')!;
    const pinCount = () => { pinPicker.querySelector('[data-pin-count]')!.textContent = pins.size ? String(pins.size) : ''; };
    const list = (limit = 60) => {
      const q = search.value.toLocaleLowerCase().trim();
      const matches = choices.filter(({record:r}) => !q || (r.title+' '+r.id+' '+r.date).toLocaleLowerCase().includes(q));
      pinPicker.querySelector('.remote-pins')!.innerHTML = matches.slice(0,limit).map(({record:r}) => `<label class="remote-check">
        <input type="checkbox" value="${esc(r.id)}" ${pins.has(r.id) ? 'checked' : ''}><span>${esc(r.title)} <small>${esc(r.date)}</small></span></label>`).join('')
        + (matches.length > limit ? `<button type="button" class="text-button" data-more-pins>${ht("显示更多记录")}</button>` : '');
      const more = pinPicker.querySelector<HTMLButtonElement>('[data-more-pins]');
      if (more) more.onclick = () => list(limit+60);
    };
    pinCount();
    pinPicker.ontoggle = () => { if (pinPicker.open) list(); };
    search.oninput = () => list();
    pinPicker.onchange = e => {
      const check = e.target;
      if (check instanceof HTMLInputElement && check.type==='checkbox') {
        if (check.checked) pins.add(check.value); else pins.delete(check.value);
        pinCount();
      }
    };
    this.form(async data => {
      const saved = await window.meki.previewPublish(state.root,{...readLogin(data),auto:data.has('auto'),pinned:[...pins]});
      await this.publisher(state);
      this.formStatus(t("已发布于 {0}",time(saved.publishedAt)));
    },t("正在生成并上传快照…"));
    const pause = this.settings.querySelector<HTMLButtonElement>('[data-pause]');
    if (pause) pause.onclick = async () => {
      try { await window.meki.previewPause(state.root); await this.publisher(state); }
      catch (error) { this.formStatus(message(error)); }
    };
  }
  subscribe(c?: PreviewConnection) {
    this.settings.innerHTML = `<form><header class="dialog-heading"><h2 id="research-remote-settings-title">${c ? ht("订阅设置") : ht("订阅远程项目")}</h2>${close()}</header>
      <p>${c ? ht("迁移后在这里更换地址。项目 ID 相同即可继续使用这项订阅。") : ht("填写发布者提供的项目目录和只读账号。首次下载后可离线查看。")}</p>
      ${loginFields(c)}<p role="status"></p><footer>${c ? `<button type="button" class="text-button" data-remove>${ht("移除订阅")}</button>` : ''}
      <button type="submit" class="primary-button">${c ? ht("保存连接") : ht("订阅并打开")}</button></footer></form>`;
    this.form(async data => {
      const saved = await window.meki.previewSubscribe(readLogin(data),c?.id);
      this.settings.close(); await this.openProject(saved);
    },t("正在读取远程快照…"));
    const remove = this.settings.querySelector<HTMLButtonElement>('[data-remove]');
    if (remove && c) remove.onclick = async () => {
      try {
        await window.meki.previewUnsubscribe(c.id);
        this.settings.close(); await this.removed(c.id);
      } catch (error) { this.formStatus(message(error)); }
    };
  }
  private form(action:(data:FormData)=>Promise<void>, busy:string) {
    const form = this.settings.querySelector('form')!;
    form.onsubmit = async event => {
      event.preventDefault();
      const buttons = [...form.querySelectorAll<HTMLButtonElement>('button')];
      const data = new FormData(form);
      buttons.forEach(b => b.disabled = true);
      this.settings.oncancel = e => e.preventDefault();
      this.formStatus(busy);
      try { await action(data); }
      catch (error) { this.formStatus(message(error)); }
      finally { buttons.forEach(b => b.disabled = false); this.settings.oncancel = null; }
    };
    if (!this.settings.open) this.settings.showModal();
  }
  private formStatus(text:string) { const el = this.settings.querySelector('[role=status]'); if (el) el.textContent = text; }
}

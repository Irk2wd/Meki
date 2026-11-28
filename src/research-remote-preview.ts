import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown-render';
import { getLocale, ht, t } from '../electron/i18n.mjs';
import type { PreviewConnection, PreviewItem, PreviewLogin, PreviewPhase, PreviewState } from '../shared/research-preview';
import type { ResearchSnapshot } from '../shared/research';
import { phaseSpan } from '../electron/research-phases.mjs';
import { dayNumber, shiftRange } from './research-timeline-range';
import { escapeResearch as esc } from './research-tools';
import { TimelineEventLayout, type TimelineEventDay } from './research-timeline-events';
import { recordMark } from './research-record-mark';
import { evidenceWipe, supportsWipe } from './research-wipe';
import { icon } from './icons';
import './research-remote-preview.css';

const message = (error: unknown) => String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');
const time = (value: string) => new Date(value).toLocaleString(getLocale(), {dateStyle:'medium',timeStyle:'short'});
const close = () => `<button type="button" class="icon-button" data-remote-close aria-label="${ht("关闭")}">${icon('close',16)}</button>`;
const loginFields = (c?: PreviewConnection | null) => `<label>${ht("WebDAV 项目目录地址")}<input name="url" type="url" required placeholder="https://dav.example.org/projects/…" value="${esc(c?.url || '')}"></label>
  <div class="remote-login"><label>${ht("用户名")}<input name="username" autocomplete="off" value="${esc(c?.username || '')}"></label>
  <label>${ht("密码")}<input name="password" type="password" autocomplete="new-password" placeholder="${c?.username ? ht("沿用已保存的密码") : ''}"></label></div>`;
const readLogin = (data: FormData): PreviewLogin => ({url:String(data.get('url')).trim(),username:String(data.get('username')), password:String(data.get('password') || '') || undefined});

function phaseOrder(a: PreviewPhase,b: PreviewPhase,today: string) {
  const group = (p: PreviewPhase) => p.start > today ? 2 : p.end && p.end < today ? 1 : 0;
  const progress = (p: PreviewPhase) => p.latest || p.finding?.date || p.days.filter(d=>d.date<=today).at(-1)?.date || '';
  return group(a)-group(b) || (group(a) === 2 ? a.start.localeCompare(b.start)
    : group(a) === 1 ? b.end!.localeCompare(a.end!) : progress(b).localeCompare(progress(a)));
}
export class RemotePreviewUI {
  private settings = document.createElement('dialog');
  private viewer = document.createElement('dialog');
  private zoom = document.createElement('dialog');
  private markers = new TimelineEventLayout(this.viewer);
  private resize = new ResizeObserver(() => this.markers.layout());
  private eventMenu = document.createElement('dialog');
  private active?: PreviewConnection;
  private state?: PreviewState;
  private phase = '';
  private request = 0;
  private rangeDays = 0;
  private rangeStart?: number;
  private selectedItem?: string;
  private urls = new Map<string,Promise<string | null>>();

  constructor() {
    this.settings.id = 'research-remote-settings';
    this.viewer.id = 'research-remote-viewer';
    this.zoom.id = 'research-remote-image';
    this.eventMenu.id = 'research-remote-events';
    this.resize.observe(this.viewer);
    for (const dialog of [this.settings,this.viewer,this.zoom,this.eventMenu]) {
      dialog.setAttribute('aria-labelledby',dialog.id+'-title');
      dialog.addEventListener('click', e => { if ((e.target as Element).closest('[data-remote-close]')) dialog.close(); });
      document.body.append(dialog);
    }
    this.viewer.addEventListener('close',() => { this.request++; this.active = undefined; this.state = undefined; this.urls.clear(); });
    this.viewer.addEventListener('click', e => { void this.click(e).catch(error => this.status(message(error))); });
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
      this.settings.close(); await this.open(saved);
    },t("正在读取远程快照…"));
    const remove = this.settings.querySelector<HTMLButtonElement>('[data-remove]');
    if (remove && c) remove.onclick = async () => {
      try {
        await window.meki.previewUnsubscribe(c.id);
        this.settings.close(); if (this.viewer.open) this.viewer.close();
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
  private status(text:string) { const el = this.viewer.querySelector('[role=status]'); if (el) el.textContent = text; }

  async open(c:PreviewConnection) {
    const ticket = ++this.request;
    this.active = c; this.state = undefined; this.urls.clear(); this.selectedItem = undefined; this.rangeDays = 0; this.rangeStart = undefined;
    this.viewer.innerHTML = `<header class="remote-head"><h2 id="research-remote-viewer-title">${esc(c.title)}</h2><div class="remote-actions"><button class="icon-button" data-settings aria-label="${ht("订阅设置")}">${icon('settings',17)}</button><button class="icon-button" data-refresh aria-label="${ht("刷新远程预览")}">${icon('refresh',17)}</button>${close()}</div></header><p role="status">${ht("正在读取远程快照…")}</p>`;
    if (!this.viewer.open) this.viewer.showModal();
    try {
      const cached = await window.meki.previewCached(c.id);
      if (ticket !== this.request) return;
      if (cached) this.showState(cached,true);
      await this.refresh();
    } catch (error) { if (ticket === this.request) this.status(message(error)); }
  }
  private async refresh() {
    if (!this.active) return;
    const ticket = ++this.request;
    this.status(t("正在检查远程更新…"));
    try {
      const result = await window.meki.previewRefresh(this.active.id);
      if (ticket !== this.request) return;
      if (this.state?.pointer.revision !== result.pointer.revision) this.showState(result,!this.state);
      this.status(t("已同步"));
    } catch (error) {
      if (ticket === this.request) this.status(this.state ? t("正在查看本地缓存 · {0}",message(error)) : message(error));
    }
  }
  private showState(state:PreviewState,first:boolean) {
    if (state.pointer.revision !== this.state?.pointer.revision) this.urls.clear();
    this.state = state;
    state.snapshot.phases.sort((a,b)=>phaseOrder(a,b,state.snapshot.asOf));
    if (first || !state.snapshot.phases.some(p => p.id === this.phase)) this.phase = state.snapshot.phases[0]?.id || '';
    this.draw();
  }
  private draw() {
    if (!this.state) return;
    const {snapshot:s,pointer} = this.state, phase = s.phases.find(p => p.id === this.phase);
    const previousStatus = this.viewer.querySelector('[role=status]')?.textContent || '';
    const dates = s.project.start ? [s.project.start] : [...s.phases.flatMap(p=>[p.start,p.days[0]?.date || p.start]),...s.items.map(i=>i.date)];
    const first = dates.reduce((min,date)=>date < min ? date : min,s.asOf);
    const days = dayNumber(s.asOf)-dayNumber(first)+1;
    const range = shiftRange({start:first,end:s.asOf},this.rangeStart ?? dayNumber(s.asOf)-(this.rangeDays || days)+1,this.rangeDays || days);
    const n = dayNumber(range.end)-dayNumber(range.start)+1;
    const point = (d:string,offset=0) => 100*(dayNumber(d)-dayNumber(range.start)+offset)/n;
    const inside = (d:string) => d >= range.start && d <= range.end;
    const before = this.markers.capture(), markerDays = new Map<string,TimelineEventDay[]>();
    const types = new Map(s.items.map(i=>[i.kind+'/'+i.label,i]));
    const rows = s.phases.map(p => {
      const span = phaseSpan(p,s.asOf);
      const markers = p.days.filter(d=>inside(d.date)).map(d=>`<i class="remote-dot" style="left:${point(d.date,.5)}%" title="${ht("{0} · {1} 条记录，{2} 次试次",d.date,d.records,d.trials)}"></i>`).join('');
      const byDay = new Map<string,PreviewItem[]>();
      for (const item of s.items.filter(i => (i.kind === 'event' || i.figure) && i.phases.includes(p.id) && inside(i.date))) {
        const group = byDay.get(item.date) || []; group.push(item); byDay.set(item.date,group);
      }
      const sorted = [...byDay].sort(([a],[b])=>a.localeCompare(b));
      markerDays.set(p.id,sorted.map(([date,items])=>({
        point:point(date,.5)/100, latest:p.id===this.phase && date===sorted.at(-1)?.[0],
        entries:items.map(i=>({record:{id:i.id,title:i.title,date:i.date,type:i.kind+'/'+i.label,comparison:i.figure}})),
      })));
      return `<div class="remote-row"><button class="remote-phase" data-remote-phase="${esc(p.id)}" aria-pressed="${p.id === this.phase}"><strong>${esc(p.title || t("未分阶段"))}</strong><small>${esc(p.start)} – ${esc(p.end || t("进行中"))}</small></button>
        <div class="remote-track">${span.start <= range.end && span.end >= range.start ? `<i class="remote-bar" style="left:${Math.max(0,point(span.start))}%;right:${Math.max(0,100-point(span.end,1))}%"></i>` : ''}${markers}
        <div class="research-timeline-events" data-phase="${esc(p.id)}"></div></div></div>`;
    }).join('');
    this.viewer.innerHTML = `<header class="remote-head"><div><small>${ht("只读订阅")} · ${ht("快照更新于 {0}",esc(time(pointer.publishedAt)))}</small>
      <h2 id="research-remote-viewer-title">${esc(s.project.title)}</h2></div><div class="remote-actions">
      <button class="icon-button" data-settings aria-label="${ht("订阅设置")}">${icon('settings',17)}</button><button class="icon-button" data-refresh aria-label="${ht("刷新远程预览")}">${icon('refresh',17)}</button>${close()}</div></header>
      <div class="remote-content"><p class="remote-description">${esc(s.project.description)}</p><section class="remote-timeline"><header><h3>${ht("研究时间线")}</h3><div class="remote-actions">
      <select aria-label="${ht("时间范围")}" data-range>${[[0,t("全部时段")],[14,t("最近 14 天")],[30,t("最近 30 天")]].map(([v,label])=>`<option value="${v}" ${v===this.rangeDays?'selected':''}>${esc(label)}</option>`).join('')}</select>
      <button class="icon-button" data-shift="-1" aria-label="${ht("向前移动时间轴")}" ${range.start===first?'disabled':''}>${icon('back',14)}</button>
      <button class="icon-button" data-shift="1" aria-label="${ht("向后移动时间轴")}" ${range.end===s.asOf?'disabled':''}>${icon('chevron',14)}</button></div></header>
      <div class="remote-scale"><span>${range.start}</span><span>${range.end}</span></div>${rows || ht("此视图没有研究阶段。")}</section>
      ${phase ? this.details(phase,s.items.filter(i=>i.phases.includes(phase.id))) : ''}</div><footer class="remote-foot" role="status">${esc(previousStatus)}</footer>`;
    this.viewer.querySelector<HTMLSelectElement>('[data-range]')!.onchange = e => {
      this.rangeDays = Number((e.target as HTMLSelectElement).value); this.rangeStart = undefined; this.draw();
    };
    for (const b of this.viewer.querySelectorAll<HTMLButtonElement>('[data-shift]')) b.onclick = () => {
      this.rangeStart = dayNumber(shiftRange({start:first,end:s.asOf},dayNumber(range.start)+Number(b.dataset.shift)*Math.max(1,Math.round(n/2)),n).start);
      this.draw();
    };
    this.markers.show(markerDays,types,before);
    for (const marker of this.viewer.querySelectorAll<HTMLElement>('[data-research-timeline-events]'))
      if (!marker.dataset.researchTimelineEvents?.includes(' ')) marker.removeAttribute('aria-haspopup');
    this.loadFigures();
  }
  private details(p:PreviewPhase,items:PreviewItem[]) {
    const s = this.state!.snapshot;
    return `<section class="remote-detail"><header><h3>${esc(p.title || t("未分阶段"))}</h3><small>${ht("{0} 条实验",p.records)}</small></header>
      ${p.description ? `<p>${esc(p.description)}</p>` : ''}${p.finding ? `<div class="remote-finding"><small>${ht("最近结论")} · ${p.finding.date}</small><p>${esc(p.finding.text)}</p></div>` : ''}
      ${p.goals.length && s.project.phaseGoals!=='hidden' ? `<ul class="remote-goals">${p.goals.map(g=>`<li>${s.project.phaseGoals==='checklist' ? (g.done?'☑ ':'☐ ') : ''}${esc(g.text)}</li>`).join('')}</ul>` : ''}
      ${items.map(i=>`<details class="remote-item" data-item="${esc(i.id)}" ${this.selectedItem===i.id?'open':''}><summary>${recordMark(i.kind,16,i.icon)}<strong>${esc(i.title)}</strong><small>${esc(i.label)} · ${i.date}</small></summary>
        ${i.coverage ? `<small>${i.coverage.start} – ${i.coverage.end}</small>` : ''}${i.text ? `<p>${esc(i.text)}</p>` : ''}${i.figure ? this.figure(i) : ''}${i.body ? `<article class="remote-body"></article>` : ''}</details>`).join('')}</section>`;
  }
  private figure(i:PreviewItem) {
    const grid = i.figure!;
    return `<div class="remote-table"><table><thead><tr><th></th>${grid.columns.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${grid.rows.map(r=>`<tr><th scope="row">${esc(r.label)}</th>${r.images.map((h,k)=>`<td>${h ? `<button data-image="${esc(h)}" aria-label="${esc(r.label+' · '+grid.columns[k])}"><img data-thumb="${esc(h)}" alt="${esc(r.label+' · '+grid.columns[k])}"></button>` : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${supportsWipe(grid) ? `<details class="remote-wipe"><summary>${ht("滑动对比")}</summary></details>` : ''}`;
  }
  private url(hash:string) {
    if (!this.urls.has(hash)) this.urls.set(hash,window.meki.previewImage(this.active!.id,hash));
    return this.urls.get(hash)!;
  }
  private loadFigures() {
    const items = this.state!.snapshot.items;
    for (const details of this.viewer.querySelectorAll<HTMLDetailsElement>('.remote-item')) {
      const load = () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = 'true';
        for (const img of details.querySelectorAll<HTMLImageElement>('[data-thumb]'))
          void this.url(img.dataset.thumb!).then(url=>{ if (url && img.isConnected) img.src=url; }).catch(error=>this.status(message(error)));
        const i = items.find(i=>i.id===details.dataset.item);
        const body = details.querySelector('.remote-body');
        if (body && i?.body) {
          body.innerHTML = DOMPurify.sanitize(renderMarkdown(i.body).html, {
            ALLOWED_TAGS:['p','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','strong','em','del','pre','code','br','hr','sub','sup'],
            ALLOWED_ATTR:[], ALLOW_DATA_ATTR:false, ALLOW_ARIA_ATTR:false,
          });
        }
        const wipe = details.querySelector<HTMLDetailsElement>('.remote-wipe');
        if (wipe && i?.figure) wipe.ontoggle = () => {
          if (!wipe.open || wipe.querySelector('figure')) return;
          wipe.append(evidenceWipe([{title:i.title,comparison:i.figure!}], {
            preview:true, read:async id => {
              const url = await this.url(id);
              if (!url) throw Error(t("缩略图暂不可用。"));
              return {id,title:i.title,relativePath:'',source:'',kind:'image',mime:url.slice(5,url.indexOf(';')),content:url.slice(url.indexOf(',')+1)};
            },
            open:async id=>this.enlarge(id,i.title),error:e=>this.status(message(e)),
          }));
        };
      };
      details.addEventListener('toggle',load); load();
    }
  }
  private async enlarge(hash:string,label:string) {
    const url = await this.url(hash);
    if (!url || !this.viewer.open) return;
    this.zoom.innerHTML = `<header class="dialog-heading"><h2 id="research-remote-image-title">${esc(label)}</h2>${close()}</header><img alt="${esc(label)}">`;
    this.zoom.querySelector('img')!.src = url;
    if (!this.zoom.open) this.zoom.showModal();
  }
  private async click(e:Event) {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b || !this.active) return;
    if (b.hasAttribute('data-refresh')) await this.refresh();
    else if (b.hasAttribute('data-settings')) this.subscribe(this.active);
    else if (b.dataset.researchTimelineEvents) {
      const phase = b.closest<HTMLElement>('[data-phase]')!.dataset.phase!;
      const ids = b.dataset.researchTimelineEvents.split(' ');
      const openItem = (id:string) => {
        this.phase = phase; this.selectedItem = id; this.draw();
        this.viewer.querySelector(`[data-item="${CSS.escape(id)}"]`)?.scrollIntoView({block:'nearest'});
      };
      if (ids.length === 1) { openItem(ids[0]); return; }
      const items = this.state!.snapshot.items.filter(i => ids.includes(i.id));
      this.eventMenu.innerHTML = `<header class="dialog-heading"><h2 id="research-remote-events-title">${esc(b.dataset.date || '')}</h2>${close()}</header>
        <ul class="research-project-list">${items.map(i=>`<li><button data-pick-event="${esc(i.id)}">${recordMark(i.kind,16,i.icon)}<span><strong>${esc(i.title)}</strong><small>${i.date} · ${esc(i.label)}</small></span></button></li>`).join('')}</ul>`;
      this.eventMenu.onclick = e => { const pick = (e.target as Element).closest<HTMLElement>('[data-pick-event]'); if (pick) { this.eventMenu.close(); openItem(pick.dataset.pickEvent!); } };
      this.eventMenu.showModal();
    } else if (b.dataset.remotePhase !== undefined) {
      this.phase = b.dataset.remotePhase; this.selectedItem = undefined; this.draw();
      this.viewer.querySelector<HTMLButtonElement>(`[data-remote-phase="${CSS.escape(this.phase)}"]`)?.focus({preventScroll:true});
    } else if (b.dataset.image) await this.enlarge(b.dataset.image,b.getAttribute('aria-label') || '');
  }
}

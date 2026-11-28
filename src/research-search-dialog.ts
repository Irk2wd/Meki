import type { ResearchPhase, ResearchSearchDocument, ResearchSearchHit, ResearchSearchQuery, ResearchSearchResponse } from '../shared/research';
import type { SmartAnswer } from '../shared/research-ai';
import { smartMarkup, smartStatus } from './research-smart-answer';
import { smartSearchAccessNotice } from './research-ai-settings';
import { ht, t } from '../electron/i18n.mjs';
import { icon } from './icons';
import { escapeResearch as escape } from './research-tools';
import './research-search.css';

const formats = () => ({ markdown: t("文稿"), pptx: 'PPTX', pdf: 'PDF', file: t("资料") });
type OpenHit = (doc: ResearchSearchDocument, hit: ResearchSearchHit, resume?: () => void) => Promise<void>;

function location(hit: ResearchSearchHit) {
  const loc = hit.locator;
  if (loc.kind === 'cells') return t("原始数据行 {0}", loc.rows.join(', '));
  if (loc.kind === 'page') return t("第 {0} 页", loc.page);
  if (loc.kind === 'document') return t("文档标题");
  return loc.trialId ? [loc.date, loc.trialId].filter(Boolean).join(' · ') : loc.heading || t("正文第 {0} 行", loc.line);
}
export class ResearchSearchDialog {
  private dialog = document.createElement('dialog');
  private root = '';
  private generation = 0;
  private response?: Pick<ResearchSearchResponse,'results'>;
  private openHit?: OpenHit;
  private answer?: SmartAnswer;
  private token?: string;

  constructor(private notify: (message: string, error?: boolean) => void, private configure: (root:string) => Promise<void>) {
    this.dialog.id = 'research-search-dialog';
    this.dialog.setAttribute('aria-labelledby','research-search-title');
    document.body.append(this.dialog);
    window.meki.onSmartSearchProgress(({token,stage,preview}) => {
      if(token !== this.token) return;
      if (preview) this.presentAnswer(preview);
      const labels:Record<string,string> = {search:t("正在查找项目证据…"), verify:t("正在核对记录、原始数据和引用…"), synthesize:t("正在整理有出处的回答…")};
      this.dialog.querySelector<HTMLElement>('[role=status]')!.textContent = labels[stage] || labels.search;
    });
    this.dialog.addEventListener('close', () => { if (this.token) this.cancel(); });
    this.dialog.addEventListener('change', () => this.updateMode());
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.search(); });
    this.dialog.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.hasAttribute('data-search-close')) { this.dialog.close(); return; }
      if (button.hasAttribute('data-model-settings')) { void this.configure(this.root).catch(error=>this.notify(String(error),true)); return; }
      if (button.hasAttribute('data-search-cancel')) { this.cancel(); return; }
      const source = this.answer?.citations[button.dataset.smartRef || ''];
      if (source) {
        const hit = {locator:source.locator, snippet:source.snippet, revision:source.revision, dataTable:source.locator.kind==='cells'};
        this.open({id:source.id,title:source.title,format:source.format,hits:[hit]},hit,button,true); return;
      }
      if (button.dataset.resultIndex === undefined) return;
      const doc = this.response?.results[Number(button.dataset.resultIndex)], hit = doc?.hits[Number(button.dataset.hitIndex)];
      if (doc && hit) this.open(doc,hit,button,Boolean(this.answer));
    });
  }

  close() { this.dialog.close(); }

  private open(doc:ResearchSearchDocument,hit:ResearchSearchHit,button:HTMLElement,returnToResults:boolean) {
    const root = this.root, scroll = this.dialog.scrollTop;
    const resume = () => {
      if(this.root!==root || this.dialog.open || !button.isConnected) return;
      this.dialog.showModal(); this.dialog.scrollTop=scroll; button.focus({preventScroll:true});
    };
    this.dialog.close();
    void this.openHit?.(doc,hit,returnToResults ? resume : undefined).catch(error=>{if(returnToResults) resume(); this.notify(String(error),true);});
  }

  private updateMode() {
    const smart = Boolean(this.dialog.querySelector('input[value=smart]:checked'));
    this.dialog.querySelector<HTMLButtonElement>('[data-model-settings]')!.hidden = !smart;
    this.dialog.querySelector<HTMLElement>('#research-ai-access-note')!.hidden = !smart;
  }

  private cancel() {
    if (!this.token) return;
    void window.meki.cancelSmartSearch(this.token).catch(()=>{});
    this.token = undefined; ++this.generation;
    this.dialog.querySelector<HTMLElement>('.research-search-results')?.removeAttribute('aria-busy');
    this.dialog.querySelector<HTMLButtonElement>('[data-search-cancel]')!.hidden = true;
    this.dialog.querySelector<HTMLElement>('[role=status]')!.textContent = t("查询已取消");
  }

  show(root: string, phases: ResearchPhase[], openHit: OpenHit) {
    if (this.dialog.open) return;
    this.openHit = openHit;
    if (root !== this.root || !this.dialog.firstChild) {
      this.root = root;
      this.response = undefined; this.answer = undefined;
      ++this.generation;
      this.dialog.innerHTML = '<header class="dialog-heading"><h2 id="research-search-title">' + ht("搜索项目") + '</h2><button class="icon-button" type="button" data-search-close aria-label="' + ht("关闭") + '">' + icon('close',16) + '</button></header>' +
        '<form><div class="research-search-input">' + icon('search',18) + '<input name="query" type="search" maxlength="500" required autofocus aria-label="' + ht("搜索内容") + '" placeholder="' + ht("搜索实验、汇报或研究问题") + '"><button type="submit" class="primary-button">' + ht("搜索") + '</button><button type="button" data-search-cancel hidden>'+ht("取消")+'</button></div>' +
        '<div class="research-search-controls"><div class="research-search-mode" role="radiogroup" aria-label="' + ht("匹配方式") + '">' +
        '<label><input type="radio" name="mode" value="keyword" checked><span>' + ht("关键词") + '</span></label>' +
        '<label><input type="radio" name="mode" value="concept"><span>' + ht("概念") + '</span></label><label><input type="radio" name="mode" value="smart" aria-describedby="research-ai-access-note"><span>'+ht("智能检索")+'</span></label></div>' +
        '<button type="button" class="research-ai-settings-link" data-model-settings hidden>'+ht("模型设置")+'</button>' +
        '<select class="research-search-format" name="format" aria-label="' + ht("资料类型") + '"><option value="all">' + ht("所有资料") + '</option><hr>' +
        Object.entries(formats()).map(([key,label]) => '<option value="' + key + '">' + escape(label) + '</option>').join('') + '</select></div>' +
        '<p id="research-ai-access-note" class="research-ai-access-note" hidden>'+smartSearchAccessNotice()+'</p>' +
        '<details class="research-search-range"><summary>' + ht("限定阶段和日期") + '</summary><div><label>' + ht("研究阶段") + '<select name="phase"></select></label>' +
        '<label>' + ht("开始日期") + '<input type="date" name="from"></label><label>' + ht("结束日期") + '<input type="date" name="to"></label></div></details></form>' +
        '<p class="research-search-status" role="status"></p><div class="research-search-results"></div>';
    }
    const phase = this.dialog.querySelector<HTMLSelectElement>('select[name=phase]')!;
    const previous = phase.value;
    phase.innerHTML = '<option value="">' + ht("全部阶段") + '</option>' + phases.map(p => '<option value="'+escape(p.id)+'">'+escape(p.title)+'</option>').join('');
    if (phases.some(p=>p.id===previous)) phase.value = previous;
    this.dialog.showModal();
    this.dialog.querySelector<HTMLInputElement>('[name=query]')!.focus();
  }

  private async search() {
    const form = this.dialog.querySelector('form')!, data = new FormData(form);
    const input: ResearchSearchQuery = { query: String(data.get('query')).trim(),
      mode: data.get('mode') === 'concept' ? 'concept' : 'keyword', format: data.get('format') as ResearchSearchQuery['format'] };
    for (const key of ['phase','from','to'] as const) if (data.get(key)) input[key] = String(data.get(key));
    const status = this.dialog.querySelector<HTMLElement>('[role=status]')!;
    if (!input.query || input.from && input.to && input.from > input.to) {
      status.textContent = t("请填写搜索内容，并检查日期范围。"); return;
    }
    this.cancel();
    const request = ++this.generation;
    const results = this.dialog.querySelector<HTMLElement>('.research-search-results')!;
    this.response = undefined; this.answer = undefined;
    results.replaceChildren();
    results.setAttribute('aria-busy','true');
    status.textContent = input.mode === 'concept' ? t("正在匹配概念，首次使用时会下载本地模型…") : t("正在搜索项目…");
    try {
      const smart = data.get('mode')==='smart';
      let response:Pick<ResearchSearchResponse,'results'|'problems'|'warning'>;
      if (smart) {
        const token = crypto.randomUUID(); this.token = token;
        this.dialog.querySelector<HTMLButtonElement>('[data-search-cancel]')!.hidden = false;
        status.textContent = t("正在查找项目证据…");
        const answer = await window.meki.smartSearch(this.root,input,token);
        if (request!==this.generation) return;
        this.answer=answer; response={results:answer.results,problems:[]};
      } else response = await window.meki.searchResearch(this.root,input);
      if (request !== this.generation) return;
      this.response = response;
      const notes = [response.results.length ? t("找到 {0} 份资料",response.results.length) : t("没有找到匹配的资料")];
      if (response.warning) notes.push(t("概念模型暂时不可用，显示关键词结果。{0}",response.warning));
      if (response.problems.length) notes.push(t("{0} 份资料的正文暂时无法索引",response.problems.length));
      status.textContent = this.answer ? [smartStatus(this.answer),this.answer.model || (this.answer.provider==='codex' ? 'Codex CLI' : this.answer.provider)].filter(Boolean).join(' · ') : notes.join(' · ');
      if (this.answer) this.presentAnswer(this.answer);
      else results.innerHTML = this.matches(response.results);
    } catch (error) { if (request === this.generation) status.textContent = String(error); }
    finally { if (request === this.generation) { this.token=undefined; results.removeAttribute('aria-busy'); this.dialog.querySelector<HTMLButtonElement>('[data-search-cancel]')!.hidden=true; } }
  }

  private presentAnswer(answer:SmartAnswer) {
    this.answer=answer; this.response={results:answer.results};
    const results=this.dialog.querySelector<HTMLElement>('.research-search-results')!;
    const matches=this.matches(answer.results);
    results.innerHTML=smartMarkup(answer)+(matches ? '<details class="research-ai-matches"'+(answer.tables.length || answer.claims.length ? '' : ' open')+'><summary>'+ht("相关资料（{0}）",answer.results.length)+'</summary>'+matches+'</details>' : '');
  }

  private matches(docs:ResearchSearchDocument[]) {
    return docs.map((doc, index) => {
        const glyph = { markdown: 'page', pptx: 'presentation', pdf: 'report', file: 'report' }[doc.format];
        const title = `<span class="research-search-document-title">${icon(glyph, 16)}
          <strong>${escape(doc.title)}</strong><small>${escape(formats()[doc.format])}</small></span>`;
        const hitButton = (hit: ResearchSearchHit, hitIndex: number) => `
          <button type="button" class="research-search-hit" data-result-index="${index}" data-hit-index="${hitIndex}">
            ${hitIndex === 0 ? title : ''}
            <span class="research-search-at">${escape(location(hit))}${hit.dataTable ? ' · ' + ht("数据表") : ''}</span>
            <span>${escape(hit.snippet)}</span>
          </button>`;
        const extra = doc.hits.slice(1);
        return `<article data-search-document="${escape(doc.id)}">${hitButton(doc.hits[0], 0)}
          ${extra.length ? `<details><summary>${ht("另外 {0} 处命中", extra.length)}</summary>
            ${extra.map((hit, n) => hitButton(hit, n + 1)).join('')}</details>` : ''}
        </article>`;
    }).join('');
  }
}

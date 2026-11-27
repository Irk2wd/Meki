import type { AIProtocol, ResearchAIConfig } from '../shared/research-ai';
import { ht, t } from '../electron/i18n.mjs';
import { icon } from './icons';
import { escapeResearch as escape } from './research-tools';
import { bindSearchDepth, searchDepthFields } from './research-ai-depth';
import './research-ai.css';

const protocols: Record<AIProtocol,string> = { responses:'OpenAI Responses', chat:'OpenAI Chat Completions', messages:'Anthropic Messages', gemini:'Google Gemini', codex:'Codex CLI' };
export function smartSearchAccessNotice() {
  return `${icon('circle-alert')}<span>${ht("提交时，问题和相关证据片段会发送给所选模型。")}<small>${ht("智能检索可读取当前项目的全部研究记录和已登记资料。")}</small></span>`;
}

export class ResearchAISettingsDialog {
  private dialog = document.createElement('dialog');
  private generation = 0;
  constructor() {
    this.dialog.id = 'research-ai-settings';
    this.dialog.setAttribute('aria-labelledby','research-ai-settings-title');
    document.body.append(this.dialog);
    this.dialog.addEventListener('close', () => {
      ++this.generation;
      this.dialog.replaceChildren();
    });
  }

  async show(root: string) {
    if (this.dialog.open) return;
    const request = ++this.generation;
    const state = await window.meki.researchAISettings(root);
    if (request !== this.generation || this.dialog.open) return;
    const current = state.value, preset = state.presets.find(p => p.id === current?.provider) || state.presets[0];
    const dlg = this.dialog;
    dlg.innerHTML = '<header class="dialog-heading"><h2 id="research-ai-settings-title">' + ht("智能检索与模型") + '</h2><button class="icon-button" type="button" data-ai-close aria-label="'+ht("关闭")+'">'+icon('close',16)+'</button></header>' +
      '<form class="research-ai-form"><div class="research-ai-fields"><label>'+ht("模型服务")+'<select name="provider">'+state.presets.map(p=>'<option value="'+escape(p.id)+'">'+escape(p.name)+'</option>').join('')+'</select></label>' +
      '<label>'+ht("连接协议")+'<select name="protocol">'+Object.entries(protocols).map(([id,label])=>'<option value="'+id+'">'+escape(label)+'</option>').join('')+'</select></label></div>' +
      '<label data-http>'+ht("API 根地址")+'<input type="url" name="base" spellcheck="false" placeholder="https://…"></label>' +
      '<label data-http>'+ht("API 密钥")+'<input type="password" name="key" autocomplete="new-password"></label>' +
      '<label data-cli>'+ht("Codex 可执行文件")+'<input name="cliPath" spellcheck="false" placeholder="codex"><small>'+ht("沿用本机 Codex 登录。若应用找不到命令，可填入完整路径。")+'</small></label>' +
      '<label>'+ht("模型 ID")+'<span class="research-ai-model-row"><input name="model" list="research-ai-model-list" spellcheck="false"><datalist id="research-ai-model-list"></datalist><button type="button" class="secondary-button" data-http data-model-list>'+ht("获取模型列表")+'</button></span></label>' +
      '<p class="research-ai-access-note">'+smartSearchAccessNotice()+'</p>' +
      searchDepthFields() +
      '<footer><span role="status" aria-live="polite"></span><button type="submit" class="primary-button">'+ht("保存")+'</button></footer></form>';
    const form = dlg.querySelector<HTMLFormElement>('form')!;
    const field = <T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as T;
    const status = dlg.querySelector<HTMLElement>('[role=status]')!;
    const models = dlg.querySelector<HTMLDataListElement>('datalist')!;
    const listButton = dlg.querySelector<HTMLButtonElement>('[data-model-list]')!;
    field('provider').value = preset.id;
    const queryLimits = bindSearchDepth(form, state);
    let changes = 0;
    const refreshProvider = () => {
      changes++;
      const chosen = state.presets.find(p=>p.id===field('provider').value)!;
      const saved = current?.provider === chosen.id ? current : undefined;
      const cli = chosen.protocol === 'codex';
      field('protocol').value = saved?.protocol || chosen.protocol;
      field('protocol').disabled = cli;
      for (const opt of field<HTMLSelectElement>('protocol').options) opt.disabled = (opt.value === 'codex') !== cli;
      for (const node of dlg.querySelectorAll<HTMLElement>('[data-http]')) node.hidden = cli;
      form.querySelector<HTMLElement>('[data-cli]')!.hidden = !cli;
      field('base').value = saved?.base || chosen.base;
      field('base').required = !cli;
      field('model').value = saved?.model || '';
      field('model').required = !cli;
      field('model').placeholder = cli ? t("留空使用当前账户默认模型") : t("输入模型 ID，或从列表选择");
      field('cliPath').value = saved?.cliPath || '';
      field('key').value = '';
      field('key').placeholder = saved && state.hasKey ? t("已配置，留空继续使用") : t("使用本机环境变量或输入密钥");
      models.replaceChildren(); status.textContent = '';
    };
    refreshProvider();
    field('provider').addEventListener('change',refreshProvider);
    const draft = ():ResearchAIConfig => ({
      provider:field('provider').value, protocol:field('protocol').value as AIProtocol,
      base:field('base').value.trim(), model:field('model').value.trim(), cliPath:field('cliPath').value.trim(),
      ...queryLimits(),
    });
    listButton.onclick = async () => {
      const generation = changes;
      listButton.disabled = true; status.textContent = t("正在获取可用模型…");
      try {
        const ids = await window.meki.researchAIModels(root,draft(),field('key').value || undefined);
        if (generation !== changes || request !== this.generation) return;
        models.replaceChildren(...ids.map(id=>{ const opt=document.createElement('option'); opt.value=id; return opt; }));
        status.textContent = ids.length ? t("可在模型 ID 输入框中选择 {0} 个模型。",ids.length) : t("服务未返回模型列表，可手动输入模型 ID。");
        field('model').focus();
      } catch (error) { if (generation===changes) status.textContent = String(error); }
      finally { listButton.disabled = false; }
    };
    dlg.querySelector<HTMLButtonElement>('[data-ai-close]')!.onclick = () => dlg.close();
    form.onsubmit = async event => {
      event.preventDefault();
      const save = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      save.disabled = true;
      try { await window.meki.saveResearchAISettings(root,draft(),field('key').value || undefined); if (request === this.generation) dlg.close(); }
      catch (error) { status.textContent = String(error); }
      finally { save.disabled = false; }
    };
    dlg.showModal();
  }
}

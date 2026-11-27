import type { ResearchAISettings, ResearchDepthPreset, ResearchQueryLimits } from '../shared/research-ai';
import { getLocale, ht, t } from '../electron/i18n.mjs';

type Depth = ResearchDepthPreset | 'custom';

export function searchDepthFields() {
  const choices: [Depth, string, string][] = [
    ['quick', ht("快速"), ht("定位一条记录")],
    ['standard', ht("标准"), ht("核对基线与复测")],
    ['deep', ht("深入"), ht("追溯多轮实验")],
    ['custom', ht("自定义"), ht("手动设定上限")],
  ];
  return `<fieldset class="research-ai-depth">
    <legend>${ht("检索深度")}</legend>
    <div class="research-ai-depth-options">${choices.map(([id, label, hint]) =>
      `<label><input type="radio" name="depth" value="${id}"><strong>${label}</strong><small>${hint}</small></label>`
    ).join('')}</div>
    <p data-depth-limits aria-live="polite"></p>
    <fieldset class="research-ai-fields research-ai-custom-limits" aria-label="${ht("自定义检索上限")}" hidden disabled>
      <label>${ht("最多补查几轮")}<select name="rounds">
        ${[1, 2, 3, 4].map(rounds => `<option value="${rounds}">${rounds}</option>`).join('')}
      </select></label>
      <label>${ht("每次提问的 token 预算")}<input type="number" name="budget" min="4000" max="120000" step="1" inputmode="numeric" required aria-describedby="research-ai-budget-range">
        <small id="research-ai-budget-range">${ht("可设为 4,000 至 120,000。")}</small></label>
    </fieldset>
    <p class="research-ai-depth-help">${ht("找到足够的证据就可以回答。每轮补查可以核对多份资料，发给模型的内容和它的回复都计入本次提问的预算。")}</p>
  </fieldset>`;
}

export function bindSearchDepth(form: HTMLFormElement, { depths, value }: ResearchAISettings) {
  const radios = form.querySelectorAll<HTMLInputElement>('input[name=depth]');
  const custom = form.querySelector<HTMLFieldSetElement>('.research-ai-custom-limits')!;
  const rounds = custom.querySelector<HTMLSelectElement>('[name=rounds]')!;
  const budget = custom.querySelector<HTMLInputElement>('[name=budget]')!;
  const summary = form.querySelector<HTMLElement>('[data-depth-limits]')!;
  const saved = value ?? depths.standard;
  const presets = Object.keys(depths) as ResearchDepthPreset[];
  let selected: Depth = presets.find(id => depths[id].rounds === saved.rounds && depths[id].tokenBudget === saved.tokenBudget) ?? 'custom';
  let customEdited = selected === 'custom';
  rounds.value = String(saved.rounds);
  budget.value = String(saved.tokenBudget);

  const select = (id: Depth) => {
    selected = id;
    const isCustom = id === 'custom';
    custom.hidden = custom.disabled = !isCustom;
    summary.hidden = isCustom;
    if (id === 'custom') return;
    const limits = depths[id];
    summary.textContent = t("最多补查 {0} 轮 · 每次提问预算 {1} tokens", limits.rounds, limits.tokenBudget.toLocaleString(getLocale()));
    if (!customEdited) {
      rounds.value = String(limits.rounds);
      budget.value = String(limits.tokenBudget);
    }
  };

  custom.addEventListener('input', () => { customEdited = true; });
  for (const radio of radios) {
    radio.checked = radio.value === selected;
    radio.addEventListener('change', () => select(radio.value as Depth));
  }
  select(selected);
  return (): ResearchQueryLimits => selected === 'custom'
    ? { rounds: Number(rounds.value), tokenBudget: budget.valueAsNumber }
    : depths[selected];
}

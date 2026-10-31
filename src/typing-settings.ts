import { ht } from '../electron/i18n.mjs';
import { typingDefaults, type TypingSettings } from './typing-rules.ts';

/** Mount inside the existing writing/style settings, keeping changes on its normal persistence path. */
export function installTypingSettings(parent: HTMLElement, change: (patch: Partial<TypingSettings>) => void) {
  const group = document.createElement('details'); group.className = 'typing-settings';
  group.innerHTML = `<summary>${ht("输入习惯")}</summary>
    <label class="setting-row">${ht("括号与引号配对")}<select id="typing-auto-pair" aria-label="${ht("括号与引号配对")}"><option value="default">${ht("沿用编辑器默认")}</option><option value="on">${ht("开启")}</option><option value="off">${ht("关闭")}</option></select></label>
    <label class="setting-row">${ht("Markdown 符号包围选区")}<input id="typing-markdown-pairs" type="checkbox"></label>
    <label class="setting-row">${ht("智能弯引号")}<input id="typing-smart-quotes" type="checkbox"></label>
    <label class="setting-row">${ht("双连字符转为长破折号")}<input id="typing-smart-dashes" type="checkbox"></label>
    <p class="setting-note">${ht("默认沿用编辑器现有行为，开启后也用于编辑模式正文。符号包围选区与智能标点默认关闭，只作用于编辑模式的正文；代码、公式和中文输入法组合期间保留原样。每次改写均可撤销。")}</p>`;
  parent.append(group);
  const pair = group.querySelector<HTMLSelectElement>('#typing-auto-pair')!;
  pair.addEventListener('change', () => change({ typingAutoPair: pair.value as TypingSettings['typingAutoPair'] }));
  const boxes = [['typing-markdown-pairs', 'typingMarkdownPairs'], ['typing-smart-quotes', 'typingSmartQuotes'], ['typing-smart-dashes', 'typingSmartDashes']] as const;
  for (const [id, key] of boxes) group.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', event => change({ [key]: (event.target as HTMLInputElement).checked }));
  return { apply(input: Partial<TypingSettings>) {
    const settings = { ...typingDefaults, ...input }; pair.value = settings.typingAutoPair;
    for (const [id, key] of boxes) group.querySelector<HTMLInputElement>(`#${id}`)!.checked = settings[key];
  } };
}

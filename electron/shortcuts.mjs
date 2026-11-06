import { t } from './i18n.mjs';
// Pure policy shared by Electron menus and the renderer. No filesystem or DOM access.
export const shortcutCatalog = Object.freeze([
  ['new', "新建文稿", 'Mod+N'], ['open', "打开文稿", 'Mod+O'], ['folder', "打开文件夹", 'Mod+Shift+O'],
  ['save', "保存", 'Mod+S'], ['saveAs', "另存为", 'Mod+Shift+S'], ['new-window', "新建窗口", 'Mod+Shift+N'],
  ['close-tab', "关闭文稿", 'Mod+W'], ['close-all', "关闭全部文稿", 'Mod+Shift+W'], ['reopen-closed', "重新打开刚关闭文稿", 'Mod+Shift+T'],
  ['source', "源码与编辑切换", 'Mod+Slash'], ['find', "查找", 'Mod+F'], ['replace', "查找与替换", 'Mod+H', 'Mod+Alt+F'],
  ['find-next', "下一个匹配", 'F3', 'Mod+G'], ['find-prev', "上一个匹配", 'Shift+F3', 'Mod+Shift+G'],
  ['quick-open', "快速打开", 'Mod+K'], ['workspace-search', "搜索工作区", 'Mod+Shift+K'], ['focus', "专注模式", 'Mod+Shift+F'],
  ['export-pdf', "导出 PDF", 'Mod+P'], ['edit-link', "插入链接", 'Mod+Alt+K'],
  ['format-paragraph', "正文", 'Mod+0'],
  ['format-h1', "一级标题", 'Mod+1'], ['format-h2', "二级标题", 'Mod+2'], ['format-h3', "三级标题", 'Mod+3'],
  ['format-h4', "四级标题", 'Mod+4'], ['format-h5', "五级标题", 'Mod+5'], ['format-h6', "六级标题", 'Mod+6'],
  ['edit-copy-text', "复制为纯文本", 'Mod+Shift+C'], ['edit-copy-markdown', "复制为 Markdown", 'Mod+Alt+C'],
  ['edit-paste-text', "粘贴纯文本", 'Mod+Shift+V'], ['edit-paste-markdown', "粘贴 Markdown", 'Mod+Alt+V'],
  ['math', "插入公式", null], ['image', "插入图片", null], ['diagram', "插入 Mermaid 图表", null],
].map(([id, label, normal, mac]) => Object.freeze({ id, get label() { return t(label); }, normal, mac: mac === undefined ? normal : mac })));
export const shortcutIds = new Set(shortcutCatalog.map(item => item.id));
export function defaultBinding(id, platform) { const item = shortcutCatalog.find(item => item.id === id); return item ? (platform === 'darwin' ? item.mac : item.normal) : null; }
export function bindings(overrides = {}, platform = 'win32') { return Object.fromEntries(shortcutCatalog.map(item => [item.id, Object.hasOwn(overrides, item.id) ? overrides[item.id] : defaultBinding(item.id, platform)])); }
export function normalizeBinding(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 48) throw new Error(t("快捷键格式不正确。"));
  const parts = value.split('+'), key = parts.pop(), modifiers = new Set(parts);
  if (modifiers.size !== parts.length || parts.some(part => !['Mod', 'Alt', 'Shift'].includes(part)) || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Slash|Comma|Period|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/.test(key || '')) throw new Error(t("请选择字母、数字、标点或 F1–F12，并搭配 Ctrl / ⌘。"));
  if (!modifiers.has('Mod') && !/^F\d+$/.test(key)) throw new Error(t("字符快捷键必须包含 Ctrl / ⌘，以免影响正常输入。"));
  return [...['Mod', 'Alt', 'Shift'].filter(part => modifiers.has(part)), key].join('+');
}
export function reservedBinding(value, platform) {
  if (!value) return false;
  if (['F5', 'F11', 'F12', 'Alt+F4', 'Mod+Q', 'Mod+R', 'Mod+Shift+R', 'Mod+Shift+I', 'Mod+Alt+I', 'Mod+Minus', 'Mod+Equal', 'Mod+Shift+Equal', 'Mod+Shift+0'].includes(value)) return true;
  if (/^Mod\+(?:[ABICUVXYZ]|Shift\+Z)$/.test(value)) return true;
  if (/^Mod\+(?:[7-9]|(?:Alt|Shift)\+[1-9])$/.test(value) || /^Mod\+Shift\+(?:B|E|U|X|L|7|8|9)$/.test(value)) return true;
  if (['Mod+BracketLeft', 'Mod+BracketRight', 'Mod+Backslash', 'Mod+Shift+Backslash', 'Mod+D'].includes(value)) return true;
  return platform === 'darwin' && ['Mod+H', 'Mod+Alt+H', 'Mod+M', 'Mod+Alt+M'].includes(value);
}
export function validateBindings(input, platform = 'win32') {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > shortcutCatalog.length) throw new Error(t("快捷键设置不正确。"));
  const result = {};
  for (const [id, value] of Object.entries(input)) {
    if (!shortcutIds.has(id)) throw new Error(t("未知快捷键命令。"));
    const binding = normalizeBinding(value);
    if (reservedBinding(binding, platform)) throw new Error(t("此按键为系统或文字编辑保留，请选择其他组合。"));
    result[id] = binding;
  }
  const occupied = new Map();
  for (const [id, binding] of Object.entries(bindings(result, platform))) {
    if (!binding) continue;
    if (occupied.has(binding)) throw new Error(t("与“{0}”的快捷键冲突，请先更改或清除该项。", shortcutCatalog.find(item => item.id === occupied.get(binding)).label));
    occupied.set(binding, id);
  }
  return result;
}
export function eventBinding(event, platform = 'win32') {
  const control = event.ctrlKey ?? event.control, meta = event.metaKey ?? event.meta;
  if (platform === 'darwin' ? control : meta) return null;
  const mod = platform === 'darwin' ? meta : control;
  const code = event.code || '', key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : code || String(event.key || '').toUpperCase();
  if (!key || /^(?:Control|Meta|Alt|Shift)(?:Left|Right)?$/.test(key)) return null;
  return [mod ? 'Mod' : '', event.altKey ?? event.alt ? 'Alt' : '', event.shiftKey ?? event.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}
export function commandFor(event, overrides, platform) {
  const binding = eventBinding(event, platform); if (!binding) return null;
  return Object.entries(bindings(overrides, platform)).find(([, value]) => value === binding)?.[0] || null;
}
export function accelerator(binding, platform = 'win32') {
  if (!binding) return undefined;
  const keys = { Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' };
  return binding.split('+').map(part => part === 'Mod' ? platform === 'darwin' ? 'Cmd' : 'Ctrl' : keys[part] || part).join('+');
}
export function shortcutLabel(binding, platform) { return accelerator(binding, platform)?.replace('Cmd', '⌘').replaceAll('+', ' + ') || t("未分配"); }

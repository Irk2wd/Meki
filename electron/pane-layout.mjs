import { t } from './i18n.mjs';
export const MAX_PANES = 4;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
export function groups(layout) {
  return !layout ? [] : layout.type === 'group' ? [layout] : [...groups(layout.first), ...groups(layout.second)];
}
export function validateLayout(layout, documents) {
  const allowed = new Set(documents), used = new Set(), ids = new Set();
  let count = 0;
  function visit(node, depth = 0) {
    if (!node || depth > MAX_PANES - 1) throw new TypeError(t("分栏布局无效。"));
    if (node.type === 'group') {
      if (++count > MAX_PANES || !identifier(node.id) || ids.has(node.id) || !Array.isArray(node.tabs) || !node.tabs.length || node.tabs.length > 24) throw new TypeError(t("分栏布局无效。"));
      ids.add(node.id);
      const tabs = node.tabs.map(id => { if (!allowed.has(id) || used.has(id)) throw new TypeError(t("分栏中的文稿重复或已关闭。")); used.add(id); return id; });
      if (!tabs.includes(node.activeId)) throw new TypeError(t("分栏的当前文稿无效。"));
      return { type: 'group', id: node.id, tabs, activeId: node.activeId };
    }
    if (node.type !== 'split' || !['row', 'column'].includes(node.axis) || !Number.isFinite(node.ratio) || node.ratio < .1 || node.ratio > .9) throw new TypeError(t("分栏比例无效。"));
    return { type: 'split', axis: node.axis, ratio: node.ratio, first: visit(node.first, depth + 1), second: visit(node.second, depth + 1) };
  }
  const result = visit(layout);
  if (used.size !== allowed.size) throw new TypeError(t("分栏布局缺少文稿。"));
  return result;
}
// Prune closed/missing documents while keeping the surviving split proportions.
export function reconcileLayout(layout, documents, activeId) {
  if (!documents.length) return undefined;
  const allowed = new Set(documents), seen = new Set();
  function prune(node) {
    if (!node) return null;
    if (node.type === 'group') {
      const tabs = node.tabs.filter(id => allowed.has(id) && !seen.has(id) && seen.add(id));
      return tabs.length ? { ...node, tabs, activeId: tabs.includes(node.activeId) ? node.activeId : tabs[0] } : null;
    }
    const first = prune(node.first), second = prune(node.second);
    return first && second ? { ...node, first, second } : first || second;
  }
  const result = prune(layout) || { type: 'group', id: 'primary', tabs: [], activeId: documents[0] };
  const target = groups(result).find(group => group.tabs.includes(activeId)) || groups(result)[0];
  target.tabs.push(...documents.filter(id => !seen.has(id)));
  if (!target.tabs.includes(target.activeId)) target.activeId = target.tabs[0];
  return result;
}
export function dockTab(layout, tabId, targetId, edge, beforeId, newId) {
  const next = structuredClone(layout), all = groups(next);
  const source = all.find(group => group.tabs.includes(tabId)), target = all.find(group => group.id === targetId);
  if (!source || !target) throw new Error(t("文稿或分栏已变化，请重新拖动。"));
  if (edge && !['left', 'right', 'top', 'bottom'].includes(edge)) throw new Error(t("无效的分栏方向。"));
  if (edge && source === target && source.tabs.length === 1) return next;
  if (edge && all.length >= MAX_PANES && source.tabs.length > 1) throw new Error(t("一个窗口最多分成 4 栏。"));
  if (!edge && beforeId === tabId && source === target) return next;
  source.tabs = source.tabs.filter(id => id !== tabId);
  if (source.activeId === tabId) source.activeId = source.tabs[0];
  function replace(node) {
    if (node.type === 'group') {
      if (node !== target) return node.tabs.length ? node : null;
      if (!edge) {
        const index = node.tabs.indexOf(beforeId);
        node.tabs.splice(index < 0 ? node.tabs.length : index, 0, tabId); node.activeId = tabId; return node;
      }
      const added = { type: 'group', id: newId, tabs: [tabId], activeId: tabId };
      const before = edge === 'left' || edge === 'top';
      return { type: 'split', axis: ['left', 'right'].includes(edge) ? 'row' : 'column', ratio: .5, first: before ? added : node, second: before ? node : added };
    }
    const first = replace(node.first), second = replace(node.second);
    return first && second ? { ...node, first, second } : first || second;
  }
  return validateLayout(replace(next), all.flatMap(group => group.tabs).concat(tabId));
}
export function mergeGroup(layout, groupId) {
  const all = groups(layout), source = all.find(group => group.id === groupId);
  if (!source || all.length < 2) return structuredClone(layout);
  const target = all[Math.max(0, all.indexOf(source) - 1)] === source ? all[1] : all[Math.max(0, all.indexOf(source) - 1)];
  let next = layout;
  for (const tab of source.tabs) next = dockTab(next, tab, target.id, null, null, 'unused');
  return next;
}

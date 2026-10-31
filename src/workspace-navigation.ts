import type { WorkspaceEntry } from '../shared/moye';

export interface NavigationRow { entry: WorkspaceEntry; level: number; position: number; size: number }
export function navigationRows(entries: WorkspaceEntry[], root: string, collapsed: Set<string>, sort: string, filter = ''): NavigationRow[] {
  const compare = (a: WorkspaceEntry, b: WorkspaceEntry) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || (sort === 'modified' ? b.modifiedAt - a.modifiedAt : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }) * (sort === 'name-desc' ? -1 : 1);
  if (filter) {
    const found = entries.filter(entry => entry.relativePath.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).sort(compare);
    return found.map((entry, index) => ({ entry, level: 1, position: index + 1, size: found.length }));
  }
  const children = new Map<string, WorkspaceEntry[]>();
  for (const entry of entries) { const group = children.get(entry.parentPath) || []; group.push(entry); children.set(entry.parentPath, group); }
  const rows: NavigationRow[] = [], visited = new Set<string>();
  const branch = (parent: string, level: number) => {
    const group = (children.get(parent) || []).sort(compare);
    group.forEach((entry, index) => {
      if (visited.has(entry.path)) return;
      visited.add(entry.path); rows.push({ entry, level, position: index + 1, size: group.length });
      if (entry.kind === 'directory' && !collapsed.has(entry.path)) branch(entry.path, level + 1);
    });
  };
  branch(root, 1); return rows;
}

/** Keep an existing node, otherwise its nearest visible ancestor, then a nearby row. */
export function retainNavigationPath(selected: string, rows: NavigationRow[], previous: NavigationRow[], preferred = '') {
  const visible = new Set(rows.map(row => row.entry.path));
  if (visible.has(selected)) return selected;
  const old = new Map(previous.map(row => [row.entry.path, row.entry.parentPath]));
  const visited = new Set<string>(); let parent = old.get(selected);
  while (parent && !visited.has(parent)) {
    if (visible.has(parent)) return parent;
    visited.add(parent); parent = old.get(parent);
  }
  if (visible.has(preferred)) return preferred;
  return rows[Math.max(0, Math.min(rows.length - 1, previous.findIndex(row => row.entry.path === selected)))]?.entry.path || '';
}

export function navigationKey(rows: NavigationRow[], selected: string, key: string, collapsed: Set<string>, filtered: boolean) {
  const index = rows.findIndex(row => row.entry.path === selected), row = rows[index];
  if (!row) return {};
  const entry = row.entry;
  if (key === 'Home') return { focus: rows[0].entry.path };
  if (key === 'End') return { focus: rows.at(-1)!.entry.path };
  if (key === 'ArrowDown' || key === 'ArrowUp') return { focus: rows[Math.max(0, Math.min(rows.length - 1, index + (key === 'ArrowDown' ? 1 : -1)))].entry.path };
  if (key === 'ArrowRight' && entry.kind === 'directory') {
    if (filtered || collapsed.has(entry.path)) return { toggle: entry.path };
    if (rows[index + 1]?.entry.parentPath === entry.path) return { focus: rows[index + 1].entry.path };
  }
  if (key === 'ArrowLeft') {
    if (entry.kind === 'directory' && !collapsed.has(entry.path) && !filtered) return { toggle: entry.path };
    if (rows.some(row => row.entry.path === entry.parentPath)) return { focus: entry.parentPath };
  }
  if (key === 'Enter' || key === ' ') return entry.kind === 'directory' ? { toggle: entry.path } : { open: entry.path };
  if (key === 'F2') return { rename: entry.path };
  return {};
}

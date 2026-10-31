import { t } from '../electron/i18n.mjs';
/** Number actual outline ancestors; skipped Markdown levels do not invent empty chapters. */
export function numberHeadings(levels: readonly number[]): string[] {
  const stack: Array<{ level: number; path: number[]; children: number }> = [{ level: 0, path: [], children: 0 }];
  return levels.map(level => {
    if (!Number.isInteger(level) || level < 1 || level > 6) throw new RangeError('Heading levels must be integers from 1 to 6.');
    while (stack.at(-1)!.level >= level) stack.pop();
    const parent = stack.at(-1)!, path = [...parent.path, ++parent.children];
    stack.push({ level, path, children: 0 });
    return path.join('.');
  });
}

export function numberedHeadingTitle(title: string, number?: string) {
  return `${number ? `${number} ` : ''}${title || t("未命名标题")}`;
}

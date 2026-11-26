// Index logical records without retaining every cell of a large timing log.
export function scanRows(text, delimiter, start, onRow, onField) {
  let fieldStart = start, column = 0, quoted = false;
  for (let i = start; i <= text.length; i++) {
    const char = text[i];
    if (char === '"' && (quoted || i === fieldStart)) {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (i < text.length && (quoted || (char !== delimiter && char !== '\r' && char !== '\n'))) continue;
    if (i === text.length && i === fieldStart && column === 0) return;
    onField?.(column, fieldStart, i);
    column++;
    if (char !== delimiter) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (!onRow(i + 1, column)) return;
      column = 0;
    }
    fieldStart = i + 1;
  }
}

export function readRows(text, delimiter, offset, skip, count, startColumn, columns) {
  let cells = [];
  const rows = [];
  scanRows(text, delimiter, offset, () => {
    if (skip > 0) skip--;
    else { rows.push(cells); cells = []; }
    return rows.length < count;
  }, (column, start, end) => {
    if (skip || column < startColumn || column >= startColumn + columns) return;
    const field = text.slice(start, end);
    cells.push(field.startsWith('"') && field.endsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field);
  });
  return rows;
}

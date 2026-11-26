export function scanRows(text: string, delimiter: string, start: number, onRow: (next: number, width: number) => boolean, onField?: (column: number, start: number, end: number) => void): void;
export function readRows(text: string, delimiter: string, offset: number, skip: number, count: number, startColumn: number, columns: number): string[][];

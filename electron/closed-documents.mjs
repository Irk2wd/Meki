// Window-local, in-memory history. Editor states/undo histories are intentionally not retained.
export const CLOSED_LIMITS = Object.freeze({ count: 20, bytes: 32 * 1024 * 1024 });
export class ClosedDocuments {
  #entries = [];
  #bytes = 0;
  get length() { return this.#entries.length; }
  get bytes() { return this.#bytes; }
  peek() { return this.#entries.at(-1)?.entry; }
  pop() { const item = this.#entries.pop(); if (item) this.#bytes -= item.bytes; return item?.entry; }
  push(entries) {
    for (const entry of entries) {
      if (!entry.document.path && !entry.document.content && !entry.dirty) continue;
      const bytes = new TextEncoder().encode(entry.document.content).length + new TextEncoder().encode(entry.savedContent).length;
      if (bytes > CLOSED_LIMITS.bytes) continue;
      this.#entries.push({ entry: structuredClone(entry), bytes }); this.#bytes += bytes;
      while (this.#entries.length > CLOSED_LIMITS.count || this.#bytes > CLOSED_LIMITS.bytes) this.#bytes -= this.#entries.shift().bytes;
    }
  }
}

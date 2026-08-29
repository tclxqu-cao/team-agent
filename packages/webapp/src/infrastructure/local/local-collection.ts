/**
 * Tiny localStorage-backed collection used by adapters for capabilities the
 * server does not expose yet (agent definitions, LSP servers). Keeps the
 * management UIs functional on a per-device basis until server routes land.
 */
export class LocalCollection<T extends { id: string }> {
  constructor(private readonly storageKey: string) {}

  list(): T[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey) ?? "[]");
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  upsert(entry: T): void {
    const list = this.list().filter((item) => item.id !== entry.id);
    list.push(entry);
    localStorage.setItem(this.storageKey, JSON.stringify(list));
  }

  remove(id: string): void {
    localStorage.setItem(this.storageKey, JSON.stringify(this.list().filter((item) => item.id !== id)));
  }
}

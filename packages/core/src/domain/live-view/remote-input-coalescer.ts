export type RemoteInputQueueKind = "hover" | "down" | "up" | "barrier";
/** Only adjacent hover positions are replaceable; dragging and key/button boundaries survive. */
export class RemoteInputCoalescer<T> {
  private entries: { value: T; hover: boolean }[] = [];
  private buttons = 0;
  offer(value: T, kind: RemoteInputQueueKind): { replaced?: T } {
    const hover = kind === "hover" && this.buttons === 0;
    if (kind === "down") this.buttons++;
    if (kind === "up") this.buttons = Math.max(0, this.buttons - 1);
    const tail = this.entries.at(-1);
    if (hover && tail?.hover) { const replaced = tail.value; tail.value = value; return { replaced }; }
    this.entries.push({ value, hover });
    return {};
  }
  shift(): T | undefined { return this.entries.shift()?.value; }
  reset(): T[] { const values = this.entries.map(entry => entry.value); this.entries = []; this.buttons = 0; return values; }
  get size(): number { return this.entries.length; }
}

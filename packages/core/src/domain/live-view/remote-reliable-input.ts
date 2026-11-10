interface InputRecord<T, R> {
  sequence: number; fingerprint: string; value: T; promise: Promise<R>;
  resolve(value: R): void; reject(error: Error): void; completedAt?: number;
}

const inputError = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Ordered, bounded operation receipts shared by reliable transport and fallback ports. */
export class RemoteReliableInputLedger<T, R> {
  readonly maxPending = 64;
  readonly maxReceipts = 128;
  readonly receiptLifetimeMs = 15_000;
  private records = new Map<number, InputRecord<T, R>>();
  private nextIndex = 1;
  private draining = false;
  private closed = false;
  constructor(private readonly dispatch: (value: T, sequence: number) => Promise<R>, private readonly now: () => number) {}

  offer(index: number, sequence: number, fingerprint: string, value: T): Promise<R> {
    this.prune();
    if (!Number.isSafeInteger(index) || index < 1 || !Number.isSafeInteger(sequence) || sequence < 1)
      return Promise.reject(inputError('无效的输入编号', 'EINVAL'));
    const previous = this.records.get(index);
    if (previous) return previous.sequence === sequence && previous.fingerprint === fingerprint ? previous.promise
      : Promise.reject(inputError('输入编号与内容不匹配', 'EINVAL'));
    if (this.closed || index < this.nextIndex) return Promise.reject(inputError('输入会话或确认已过期', 'ESTALE'));
    if (index - this.nextIndex >= this.maxPending) return Promise.reject(inputError('输入队列繁忙', 'EBUSY'));
    let resolve!: (value: R) => void, reject!: (error: Error) => void;
    const promise = new Promise<R>((yes, no) => { resolve = yes; reject = no; });
    this.records.set(index, { sequence, fingerprint, value, promise, resolve, reject });
    void this.drain();
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const record of this.records.values()) if (record.completedAt === undefined) {
      record.completedAt = this.now(); record.reject(inputError('输入会话已切换或控制已归还', 'ESTALE'));
    }
    this.prune();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const record = this.records.get(this.nextIndex);
        if (!record || record.completedAt !== undefined) break;
        try { record.resolve(await this.dispatch(record.value, record.sequence)); }
        catch (error) { record.reject(error instanceof Error ? error : new Error(String(error))); }
        record.completedAt = this.now(); this.nextIndex += 1; this.prune();
      }
    } finally { this.draining = false; }
  }

  private prune(): void {
    const completed = [...this.records].filter(([, record]) => record.completedAt !== undefined);
    for (let index = 0; index < completed.length; index++) {
      const [key, record] = completed[index];
      if (this.now() - record.completedAt! >= this.receiptLifetimeMs || index < completed.length - this.maxReceipts) this.records.delete(key);
    }
  }
}

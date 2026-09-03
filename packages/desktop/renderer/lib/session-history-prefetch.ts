interface PrefetchSlot<T> {
  sessionId: string;
  cursor: string;
  promise: Promise<T>;
}

export class SinglePageHistoryPrefetch<T> {
  private slot: PrefetchSlot<T> | null = null;

  prefetch(sessionId: string, cursor: string, loader: () => Promise<T>): Promise<T> {
    return this.getOrStart(sessionId, cursor, loader).promise;
  }

  async consume(sessionId: string, cursor: string, loader: () => Promise<T>): Promise<T> {
    const slot = this.getOrStart(sessionId, cursor, loader);
    try {
      return await slot.promise;
    } finally {
      if (this.slot === slot) this.slot = null;
    }
  }

  invalidate(): void {
    this.slot = null;
  }

  private getOrStart(
    sessionId: string,
    cursor: string,
    loader: () => Promise<T>,
  ): PrefetchSlot<T> {
    if (this.slot?.sessionId === sessionId && this.slot.cursor === cursor) {
      return this.slot;
    }

    let promise: Promise<T>;
    try {
      promise = loader();
    } catch (error) {
      promise = Promise.reject(error);
    }
    const slot = { sessionId, cursor, promise };
    this.slot = slot;
    void promise.catch(() => {
      if (this.slot === slot) this.slot = null;
    });
    return slot;
  }
}

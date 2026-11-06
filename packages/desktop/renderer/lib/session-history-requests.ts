/** A local submission makes every earlier snapshot of that session obsolete. */
export class SessionHistoryRequests {
  private readonly generations = new Map<string, number>();

  capture(sessionId: string): () => boolean {
    const generation = this.generations.get(sessionId) ?? 0;
    return () => (this.generations.get(sessionId) ?? 0) === generation;
  }

  invalidate(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
  }
}

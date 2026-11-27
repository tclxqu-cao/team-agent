export declare class AsyncEventQueue<T> implements AsyncIterable<T> {
    private readonly values;
    private readonly waiters;
    private closed;
    push(value: T): void;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
//# sourceMappingURL=async-event-queue.d.ts.map
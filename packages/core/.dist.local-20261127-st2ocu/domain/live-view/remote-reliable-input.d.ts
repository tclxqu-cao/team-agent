/** Ordered, bounded operation receipts shared by reliable transport and fallback ports. */
export declare class RemoteReliableInputLedger<T, R> {
    private readonly dispatch;
    private readonly now;
    readonly maxPending = 64;
    readonly maxReceipts = 128;
    readonly receiptLifetimeMs = 15000;
    private records;
    private nextIndex;
    private draining;
    private closed;
    constructor(dispatch: (value: T, sequence: number) => Promise<R>, now: () => number);
    offer(index: number, sequence: number, fingerprint: string, value: T): Promise<R>;
    close(): void;
    private drain;
    private prune;
}
//# sourceMappingURL=remote-reliable-input.d.ts.map
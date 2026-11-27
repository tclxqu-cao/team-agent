export type RemoteInputQueueKind = "hover" | "down" | "up" | "barrier";
/** Only adjacent hover positions are replaceable; dragging and key/button boundaries survive. */
export declare class RemoteInputCoalescer<T> {
    private entries;
    private buttons;
    offer(value: T, kind: RemoteInputQueueKind): {
        replaced?: T;
    };
    shift(): T | undefined;
    reset(): T[];
    get size(): number;
}
//# sourceMappingURL=remote-input-coalescer.d.ts.map
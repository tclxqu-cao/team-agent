export interface RemoteInputStamp {
    stream: string;
    sequence: number;
    index?: number;
}
export interface RemoteInputContext {
    controllerId: string;
    epoch: number;
    stream: string;
    version?: number;
}
export interface RemoteDirectPointer extends RemoteInputStamp {
    barrier: number;
    x: number;
    y: number;
    mobile?: boolean;
}
export declare function isDirectHoverInput(input: Record<string, unknown>, pressed: boolean): boolean;
/** Lossy hover messages cannot cross a reliable click/key/drag barrier. */
export declare class RemoteDirectInputPolicy {
    readonly stream: string;
    private reliable;
    private hover;
    constructor(stream: string);
    acceptReliable(stamp: unknown): boolean;
    acceptMove(value: RemoteDirectPointer): boolean;
}
/** Monotonic hover admission and spacing; a coordinator retains the latest admitted value. */
export declare class RemoteHoverDispatchPolicy {
    readonly intervalMs = 4;
    private sequence;
    private dispatchedAt;
    offer(sequence: number, now: number): number | null;
    dispatched(now: number): void;
    reset(): void;
}
//# sourceMappingURL=remote-direct-input.d.ts.map
export interface QoderActivityReader {
    readMany(sessions: readonly {
        id: string;
    }[]): Promise<ReadonlyMap<string, boolean>>;
}
interface Options {
    home?: string;
    processStarts?: (pids: readonly number[]) => Promise<ReadonlyMap<number, number>>;
}
/** ACP lists persisted sessions but omits external turn state. Native main-turn
 * boundaries and their process identity supply activity without resuming a writer. */
export declare class QoderDesktopActivityReader implements QoderActivityReader {
    private readonly root;
    private readonly processStarts;
    private readonly cursors;
    private pending;
    constructor(options?: Options);
    readMany(sessions: readonly {
        id: string;
    }[]): Promise<ReadonlyMap<string, boolean>>;
    private refresh;
    private read;
    private consume;
    private line;
}
export {};
//# sourceMappingURL=qoder-desktop-activity.d.ts.map
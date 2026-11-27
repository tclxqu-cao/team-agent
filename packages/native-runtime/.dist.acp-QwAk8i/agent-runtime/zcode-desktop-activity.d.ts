export interface ZCodeActivitySession {
    id: string;
    cwd: string;
}
export interface ZCodeActivityReader {
    readMany(sessions: readonly ZCodeActivitySession[]): Promise<ReadonlyMap<string, boolean>>;
}
interface Options {
    home?: string;
    isProcessAlive?: (pid: number) => boolean;
}
/** Legacy session/list omits live projections. Read native turn boundaries and
 * their desktop host or workspace owner without materializing or sending to a session. */
export declare class ZCodeDesktopActivityReader implements ZCodeActivityReader {
    private readonly root;
    private readonly alive;
    private readonly cursors;
    private readonly turns;
    private readonly hostTurns;
    private readonly runtimeHosts;
    private readonly owners;
    private pending;
    constructor(options?: Options);
    readMany(sessions: readonly ZCodeActivitySession[]): Promise<ReadonlyMap<string, boolean>>;
    private reset;
    private files;
    private refresh;
    private read;
    private consume;
    private line;
    private runtimeRequest;
    private delivery;
}
export {};
//# sourceMappingURL=zcode-desktop-activity.d.ts.map
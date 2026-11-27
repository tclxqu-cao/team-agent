/** ACP lists only one cwd; native transcript headers identify the other roots. */
export declare class QoderWorkspaceCatalog {
    private readonly root;
    private readonly cache;
    constructor(root?: string);
    private roots;
    list(): Promise<string[]>;
}
//# sourceMappingURL=qoder-workspace-catalog.d.ts.map
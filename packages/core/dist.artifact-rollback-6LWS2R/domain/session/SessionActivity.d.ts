export type SessionActivity = "needs-input" | "running" | "idle" | "stale" | "error";
export interface SessionActivityInput {
    authoritativeStatus: string;
    locallyRunning: boolean;
    needsInput: boolean;
    stale: boolean;
}
export declare function projectSessionActivity({ authoritativeStatus, locallyRunning, needsInput, stale, }: SessionActivityInput): SessionActivity;
export declare function visibleWorkspaceIds(selectedProjectId: string | null, expandedProjectIds: Iterable<string>): string[];
//# sourceMappingURL=SessionActivity.d.ts.map
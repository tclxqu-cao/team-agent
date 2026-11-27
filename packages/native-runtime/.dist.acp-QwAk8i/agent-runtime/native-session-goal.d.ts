/** Runtime-owned goal state, distinct from AgentRoam's queued goals and Thread Goal. */
export interface NativeGoalRef {
    id: string;
    revision: number;
}
export interface NativeSessionGoal extends NativeGoalRef {
    objective: string;
    phase: "active" | "paused" | "blocked" | "complete";
    activation: "armed" | "disarmed";
    maxGoalRounds: number;
    roundsStarted: number;
    blockedReason?: {
        code: string;
        message: string;
    };
    createdAt: number;
    updatedAt: number;
}
export type NativeGoalMutation = {
    action: "create";
    objective: string;
    maxGoalRounds?: number;
} | {
    action: "edit";
    ref: NativeGoalRef;
    objective?: string;
    maxGoalRounds?: number;
} | {
    action: "pause" | "resume" | "complete" | "clear";
    ref: NativeGoalRef;
};
/** Validate at every public boundary; revisions prevent overwriting another client's edit. */
export declare function parseNativeGoalMutation(value: unknown): NativeGoalMutation;
//# sourceMappingURL=native-session-goal.d.ts.map
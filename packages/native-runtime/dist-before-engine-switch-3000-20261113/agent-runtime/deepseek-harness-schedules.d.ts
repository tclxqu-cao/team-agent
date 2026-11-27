import { type HarnessConnection } from "./deepseek-harness-client.js";
/** Cancels reminders through their live owner; never starts a replacement Host. */
export declare class DeepSeekHarnessScheduleClient {
    private readonly connection;
    constructor(connection?: HarnessConnection);
    cancel(sessionId: string, taskId: string): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=deepseek-harness-schedules.d.ts.map
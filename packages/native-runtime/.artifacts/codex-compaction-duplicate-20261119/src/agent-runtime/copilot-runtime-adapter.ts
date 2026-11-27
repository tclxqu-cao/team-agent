import { CopilotClient } from "./copilot-client.js";
import { StdioNativeRuntimeAdapter, type NativeProtocolSession, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import type { RuntimeHealth } from "./types.js";

export interface CopilotRuntimeProtocol extends NativeSessionProtocol {
  health(): Promise<RuntimeHealth>;
  getSessionWatchPath(id: string): Promise<string | null>;
  sessionSummary(id: string): Promise<NativeProtocolSession>;
  steer(id: string, input: string, messageId?: string): Promise<boolean>;
}

export class CopilotRuntimeAdapter extends StdioNativeRuntimeAdapter {
  constructor(private readonly copilot: CopilotRuntimeProtocol = new CopilotClient()) { super("copilot", "VS Code Copilot", copilot); }

  protected override summary(session: NativeProtocolSession) {
    const summary = super.summary(session);
    // VS Code arbitrates shared clients on the same host; a live turn is not a foreign process lock.
    return { ...summary, occupancy: summary.occupancy === "owned-externally" ? "available" as const : summary.occupancy,
      canResume: !session.readOnly, nativeGoalSupported: false, nativeModelSelectionSupported: true };
  }

  override health() { return this.copilot.health(); }

  async getSessionSummary(id: string) { return this.summary(await this.copilot.sessionSummary(id)); }

  steer(id: string, input: string, messageId?: string) { return this.copilot.steer(id, input, messageId); }

  getSessionWatchPath(id: string): Promise<string | null> { return this.copilot.getSessionWatchPath(id); }
}

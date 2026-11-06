import { ZCodeClient } from "./zcode-client.js";
import { StdioNativeRuntimeAdapter, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";

export class ZCodeRuntimeAdapter extends StdioNativeRuntimeAdapter {
  constructor(private readonly zcode: NativeSessionProtocol = new ZCodeClient()) { super("zcode", "ZCode", zcode); }

  async getSessionSummary(id: string) {
    const session = (await this.zcode.list()).find(session => session.id === id);
    return session ? this.summary(session) : this.getSession(id);
  }

  steer(id: string, input: string, messageId?: string): Promise<boolean> {
    return this.zcode.steer?.(id, input, messageId) ?? Promise.resolve(false);
  }
}

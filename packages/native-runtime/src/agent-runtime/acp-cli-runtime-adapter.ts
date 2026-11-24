import { ACP_CLI_LABELS, AcpCliClient, type AcpCliAgentType } from "./acp-cli-client.js";
import { StdioNativeRuntimeAdapter } from "./stdio-native-runtime-adapter.js";

export class AcpCliRuntimeAdapter extends StdioNativeRuntimeAdapter {
  constructor(agentType: AcpCliAgentType, private readonly acp = new AcpCliClient(agentType)) {
    super(agentType, ACP_CLI_LABELS[agentType], acp);
  }

  getCapabilities() {
    return this.acp.getCapabilities();
  }

  async setNativePermissionPreset(id: string, preset: string) {
    await this.acp.setMode(id, preset);
    return this.summary((await this.acp.read(id)).session);
  }
}

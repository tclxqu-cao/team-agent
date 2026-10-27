import { QoderClient } from "./qoder-client.js";
import { StdioNativeRuntimeAdapter, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";

export class QoderRuntimeAdapter extends StdioNativeRuntimeAdapter {
  constructor(client: NativeSessionProtocol = new QoderClient()) { super("qoder", "Qoder", client); }
}

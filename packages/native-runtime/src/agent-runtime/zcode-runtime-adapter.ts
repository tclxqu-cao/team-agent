import { ZCodeClient } from "./zcode-client.js";
import { StdioNativeRuntimeAdapter, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";

export class ZCodeRuntimeAdapter extends StdioNativeRuntimeAdapter {
  constructor(client: NativeSessionProtocol = new ZCodeClient()) { super("zcode", "ZCode", client); }
}

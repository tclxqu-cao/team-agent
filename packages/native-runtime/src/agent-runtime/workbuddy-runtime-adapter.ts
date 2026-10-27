import { WorkBuddyClient } from "./workbuddy-client.js";
import { StdioNativeRuntimeAdapter, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";

export class WorkBuddyRuntimeAdapter extends StdioNativeRuntimeAdapter {
  constructor(client: NativeSessionProtocol = new WorkBuddyClient()) { super("workbuddy", "WorkBuddy", client); }
}

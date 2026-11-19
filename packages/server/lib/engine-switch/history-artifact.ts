import { materializeContextHistory, resolveNativeRuntimeDirectory } from "@agent/native-runtime";

export function materializeEngineHistory(input: Parameters<typeof materializeContextHistory>[1]): Promise<string> {
  return materializeContextHistory(resolveNativeRuntimeDirectory(), input);
}

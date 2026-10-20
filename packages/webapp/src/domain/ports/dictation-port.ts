import type { AgentApi } from "./agent-port";

/** Platform-neutral dictation contract shared by capture and gateway adapters. */
export type DictationPort = Pick<
  AgentApi,
  "dictationStart" | "dictationStop" | "onDictation" | "onDictationError"
>;

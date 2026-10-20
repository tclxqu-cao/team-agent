import type { AgentApi } from "./agent-port";

export type SpeechOutputPort = Pick<AgentApi,
  "ttsSpeak" | "ttsStop" | "ttsPlaybackEnded" | "onTtsStart" | "onTtsPcm" | "onTtsStreamEnd" | "onTtsFlush" | "onTtsEnd"
>;

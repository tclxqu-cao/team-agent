export type VoiceCaptureAction = "start" | "append" | "ignore";
export type TtsListeningMode = "barge-in" | "suspended";

export function getVoiceCaptureAction(
  capturing: boolean,
  conversation: boolean,
): VoiceCaptureAction {
  if (capturing) return "append";
  if (conversation) return "start";
  return "ignore";
}

export function isWakeMatch(
  heard: string,
  variants: readonly string[],
  isFinal: boolean,
): boolean {
  if (variants.some((variant) => heard.includes(variant))) return true;
  if (!isFinal) return false;

  return variants.some((variant) => (
    heard.length > 0
    && heard.length === variant.length - 1
    && variant.startsWith(heard)
  ));
}

export function getWakeCommandSuffix(
  heard: string,
  variants: readonly string[],
): string | null {
  const match = variants
    .map((variant) => ({ variant, index: heard.indexOf(variant) }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  return match ? heard.slice(match.index + match.variant.length) : null;
}

export function replaceWakeCommandSuffix(_current: string, suffix: string): string {
  return suffix;
}

export function shouldRestartWakeListener(desired: boolean, suspended: boolean): boolean {
  return desired && !suspended;
}

export function shouldRearmIgnoredWakeKeyword(
  windowVisible: boolean,
  wakeDesired: boolean,
): boolean {
  return windowVisible && wakeDesired;
}

export function shouldInvalidateVoiceProvider<T extends object>(
  active: T | null,
  failed: T,
): boolean {
  return active === failed;
}

export function getTtsListeningMode(conversation: boolean): TtsListeningMode {
  return conversation ? "barge-in" : "suspended";
}

export function shouldAcceptBargeIn(ttsSpeaking: boolean, conversation: boolean): boolean {
  return ttsSpeaking && conversation;
}

export async function prepareTtsListening(
  mode: TtsListeningMode,
  currentMode: "wake" | "dictation" | "barge-in" | null,
  stop: () => void,
  launchBargeIn: () => Promise<unknown>,
): Promise<void> {
  if (mode === "barge-in") {
    if (currentMode !== "barge-in") {
      stop();
      await launchBargeIn();
    }
    return;
  }
  stop();
}

export function getVoiceCaptureSilenceTimeout(commandText: string): number {
  return commandText.trim().length > 0 ? 3000 : 8000;
}

export function shouldRearmWakeOnlyCapture(
  capturing: boolean,
  isFinal: boolean,
  commandText: string,
): boolean {
  return capturing && isFinal && commandText.trim().length === 0;
}

export function shouldFinalizeVoiceCapture(
  capturing: boolean,
  isFinal: boolean,
  commandText: string,
): boolean {
  return capturing && isFinal && commandText.trim().length > 0;
}

export function parseWakeTranscriptLine(
  line: string,
): { heard: string; isFinal: boolean } | null {
  if (line.startsWith("TEXT ")) {
    return { heard: line.slice(5), isFinal: false };
  }
  if (line.startsWith("FINAL ")) {
    return { heard: line.slice(6), isFinal: true };
  }
  return null;
}

export function parseWakeControlLine(line: string): "barge-in" | null {
  return line === "BARGE_IN" ? "barge-in" : null;
}

export function routeVoiceServiceResult(
  current: { sessionId: string; generation: number; lastFinalUtteranceId: number },
  event: {
    type: "keyword" | "partial" | "final";
    sessionId: string;
    generation: number;
    utteranceId?: number;
  },
): { action: "ignore" | "keyword" | "partial" | "final"; lastFinalUtteranceId: number } {
  if (event.sessionId !== current.sessionId || event.generation !== current.generation) {
    return { action: "ignore", lastFinalUtteranceId: current.lastFinalUtteranceId };
  }
  if (event.type === "partial") {
    return { action: "partial", lastFinalUtteranceId: current.lastFinalUtteranceId };
  }
  if (event.type === "keyword") {
    return { action: "keyword", lastFinalUtteranceId: current.lastFinalUtteranceId };
  }
  if (!Number.isSafeInteger(event.utteranceId)
    || (event.utteranceId as number) <= current.lastFinalUtteranceId) {
    return { action: "ignore", lastFinalUtteranceId: current.lastFinalUtteranceId };
  }
  return { action: "final", lastFinalUtteranceId: event.utteranceId as number };
}

export function shouldAcceptTtsPlayback(
  resultGeneration: number,
  currentGeneration: number,
  speaking: boolean,
): boolean {
  return speaking && resultGeneration === currentGeneration;
}

interface NativeTtsApi {
  ttsStop?: () => Promise<{ ok: boolean }>;
}

export function interruptSpeech(
  api: NativeTtsApi | undefined,
  stopBrowserSpeech: () => void,
): Promise<void> {
  stopBrowserSpeech();
  return typeof api?.ttsStop === "function"
    ? api.ttsStop().then(() => undefined)
    : Promise.resolve();
}

interface NativeTtsApi {
  ttsStop?: () => Promise<{ ok: boolean }>;
}

export function interruptSpeech(
  api: NativeTtsApi | undefined,
  stopBrowserSpeech: () => void,
): void {
  if (typeof api?.ttsStop === "function") void api.ttsStop();
  stopBrowserSpeech();
}

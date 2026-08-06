/**
 * Speech utilities — voice input (ASR) and voice output (TTS).
 *
 * Desktop dictation prefers the native macOS Speech helper because Chromium's
 * recognition service is unavailable on the target network. Web Speech remains
 * a browser fallback; speech synthesis is used when native TTS is unavailable.
 */

// ── Types for the (untyped) webkitSpeechRecognition API ──────────────────

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface NativeDictationApi {
  dictationStart: () => Promise<{ ok: boolean; reason?: string }>;
  dictationStop: () => Promise<{ ok: boolean }>;
  onDictation: (callback: (payload: { text: string; isFinal: boolean }) => void) => () => void;
  onDictationError: (callback: (message: string) => void) => () => void;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition as SpeechRecognitionCtor) ??
    (w.webkitSpeechRecognition as SpeechRecognitionCtor) ?? null;
}

function getNativeDictationApi(): NativeDictationApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { agentApi?: Partial<NativeDictationApi> }).agentApi;
  if (
    typeof api?.dictationStart !== "function" ||
    typeof api.dictationStop !== "function" ||
    typeof api.onDictation !== "function" ||
    typeof api.onDictationError !== "function"
  ) return null;
  return api as NativeDictationApi;
}

export function isASRSupported(): boolean {
  return getNativeDictationApi() !== null || getRecognitionCtor() !== null;
}

export function isTTSSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// ── ASR: voice input ──────────────────────────────────────────────────────

export interface DictationHandle {
  stop: () => void;
}

/**
 * Start one-shot dictation. Interim text is reported via onInterim so the
 * input box can live-update; the final transcript is returned via onFinal.
 */
export function startDictation(opts: {
  lang?: string;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}): DictationHandle | null {
  const nativeApi = getNativeDictationApi();
  if (nativeApi) {
    let ended = false;
    let removeResult = () => undefined;
    let removeError = () => undefined;
    const finish = () => {
      if (ended) return;
      ended = true;
      removeResult();
      removeError();
      opts.onEnd?.();
    };
    removeResult = nativeApi.onDictation(({ text, isFinal }) => {
      const clean = text.trim();
      if (!clean) return;
      if (isFinal) {
        opts.onFinal(clean);
        finish();
      } else {
        opts.onInterim(clean);
      }
    });
    removeError = nativeApi.onDictationError((message) => {
      opts.onError?.(message);
      finish();
    });
    void nativeApi.dictationStart().then((result) => {
      if (!result.ok) {
        opts.onError?.(result.reason || "无法启动语音识别");
        finish();
      }
    }).catch(() => {
      opts.onError?.("无法启动语音识别");
      finish();
    });
    return { stop: () => { void nativeApi.dictationStop(); } };
  }

  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    opts.onError?.("当前环境不支持语音识别");
    return null;
  }
  const rec = new Ctor();
  rec.lang = opts.lang ?? "zh-CN";
  rec.continuous = false;
  rec.interimResults = true;

  let finalText = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    if (interim) opts.onInterim(finalText + interim);
  };
  rec.onerror = (ev) => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") {
      opts.onError?.(`语音识别失败：${ev.error ?? "未知错误"}`);
    }
  };
  rec.onend = () => {
    if (finalText) opts.onFinal(finalText.trim());
    opts.onEnd?.();
  };

  try {
    rec.start();
  } catch {
    // start() throws when already started — treat as no-op
    opts.onEnd?.();
    return null;
  }
  return { stop: () => rec.stop() };
}

// ── Continuous listening (wake-word detection while hidden) ──────────────

export interface WakeListenerHandle {
  stop: () => void;
}

/**
 * Loop SpeechRecognition continuously and report every recognized phrase.
 * Auto-restarts on end/error so the loop survives Chromium's ~60s
 * recognition cap. The caller decides what counts as a wake word.
 */
export function startWakeListener(opts: {
  wakeWord: string;
  lang?: string;
  onWake: (heard: string) => void;
  onHeard?: (text: string) => void;
  onError?: (message: string) => void;
}): WakeListenerHandle | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    opts.onError?.("当前环境不支持语音唤醒");
    return null;
  }

  let stopped = false;
  let rec: SpeechRecognitionLike | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const loop = () => {
    if (stopped) return;
    rec = new Ctor();
    rec.lang = opts.lang ?? "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (ev) => {
      const last = ev.results[ev.results.length - 1];
      const text = last?.[0]?.transcript?.trim();
      if (!text) return;
      if (last.isFinal) opts.onHeard?.(text);
      if (text.includes(opts.wakeWord)) opts.onWake(text);
    };
    rec.onerror = (ev) => {
      // "not-allowed" = mic permission revoked — don't hammer the loop
      if (ev.error === "not-allowed") {
        opts.onError?.("麦克风权限被拒绝，语音唤醒已停用");
        stopped = true;
      }
    };
    rec.onend = () => {
      if (stopped) return;
      // Small gap avoids hot-spinning when the mic yields nothing
      restartTimer = setTimeout(loop, 400);
    };

    try {
      rec.start();
    } catch {
      restartTimer = setTimeout(loop, 800);
    }
  };

  loop();
  return {
    stop: () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      try { rec?.abort(); } catch { /* already stopped */ }
    },
  };
}

// ── TTS: voice output ─────────────────────────────────────────────────────

/** Strip markdown syntax so TTS reads natural prose. */
export function toSpeakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "。代码已省略。")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_>#|-]{2,}/g, "")
    .replace(/\n{2,}/g, "。")
    .replace(/\n/g, "，")
    .trim();
}

let preferredVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (!isTTSSupported()) return null;
  if (preferredVoice) return preferredVoice;
  const voices = window.speechSynthesis.getVoices();
  preferredVoice =
    voices.find((v) => v.lang.startsWith("zh") && v.localService) ??
    voices.find((v) => v.lang.startsWith("zh")) ??
    voices[0] ?? null;
  return preferredVoice;
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  // Voices load asynchronously in Chromium
  window.speechSynthesis.onvoiceschanged = () => { preferredVoice = null; pickVoice(); };
}

/** Speak text. Cancels anything currently playing first. */
export function speak(text: string, opts?: { rate?: number; onEnd?: () => void }): boolean {
  if (!isTTSSupported() || !text.trim()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(toSpeakableText(text));
  utter.lang = "zh-CN";
  utter.rate = opts?.rate ?? 1.05;
  const voice = pickVoice();
  if (voice) utter.voice = voice;
  if (opts?.onEnd) {
    utter.onend = opts.onEnd;
    utter.onerror = opts.onEnd;
  }
  synth.speak(utter);
  return true;
}

export function stopSpeaking(): void {
  if (isTTSSupported()) window.speechSynthesis.cancel();
}

export function isSpeaking(): boolean {
  return isTTSSupported() && window.speechSynthesis.speaking;
}

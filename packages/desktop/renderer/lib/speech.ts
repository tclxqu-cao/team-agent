/**
 * Speech utilities — voice input (ASR) and voice output (TTS).
 *
 * Both capabilities use the Web Speech API shipped with Chromium
 * (available in Electron's renderer). The gateway currently registers
 * all providers as chat-only (no /v1/audio/* passthrough), so local
 * browser speech is the pragmatic engine. If an STT/TTS-capable
 * gateway endpoint becomes available, swap the implementations here
 * without touching the UI layer.
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

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition as SpeechRecognitionCtor) ??
    (w.webkitSpeechRecognition as SpeechRecognitionCtor) ?? null;
}

export function isASRSupported(): boolean {
  return getRecognitionCtor() !== null;
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

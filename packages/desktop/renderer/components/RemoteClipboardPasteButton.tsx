import { useEffect, useRef, useState } from "react";
import { readTextFromClipboard } from "../lib/clipboard";

/** Read the viewing device's clipboard; native paste is the fallback on restricted browsers. */
export default function RemoteClipboardPasteButton({ disabled, onPaste, onError }: {
  disabled: boolean;
  onPaste: (text: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [nativePaste, setNativePaste] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const alive = useRef(true);
  const enabled = useRef(!disabled);
  enabled.current = !disabled;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { if (nativePaste) inputRef.current?.focus({ preventScroll: true }); }, [nativePaste]);

  const paste = async (read: () => Promise<string | null>) => {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setPending(true);
    onError(null);
    try {
      const text = await read();
      if (!alive.current || !enabled.current) return;
      if (text === null) {
        setNativePaste(true);
        onError("浏览器限制读取剪贴板，请长按“系统粘贴”使用系统菜单，粘贴后自动输入电脑");
        return;
      }
      if (!text) throw new Error("剪贴板里没有文字");
      await onPaste(text);
      if (alive.current) setNativePaste(false);
    } catch (reason: unknown) {
      if (alive.current) onError(reason instanceof Error ? reason.message : "粘贴失败，请重试");
    } finally {
      pendingRef.current = false;
      if (alive.current) setPending(false);
    }
  };

  return nativePaste ? <input ref={inputRef} className="browser-live-native-paste" aria-label="系统粘贴"
    placeholder="系统粘贴" disabled={disabled || pending} defaultValue="" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
    onPaste={(event) => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      void paste(() => Promise.resolve(text));
    }}
  /> : <button type="button" disabled={disabled || pending} title="直接粘贴当前手机或电脑剪贴板的文字" onClick={() => void paste(readTextFromClipboard)}>
    {pending ? "粘贴中…" : "粘贴"}
  </button>;
}

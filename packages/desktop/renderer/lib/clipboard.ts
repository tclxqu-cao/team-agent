function copyTextWithSelection(text: string): boolean {
  if (
    typeof document === "undefined"
    || !document.body
    || typeof document.execCommand !== "function"
  ) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "-9999px",
    width: "1px",
    height: "1px",
    fontSize: "16px",
    opacity: "0",
    pointerEvents: "none",
  });

  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/** Copy text in secure browsers, Electron, and LAN-hosted mobile browsers. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const canUseClipboardApi = (
    typeof clipboard?.writeText === "function"
    && (typeof isSecureContext === "undefined" || isSecureContext)
  );

  if (canUseClipboardApi) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Browser permissions can still reject in a secure context.
    }
  }

  return copyTextWithSelection(text);
}

import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { useUIStore } from "@desktop/renderer/stores/uiStore";

export function statusBarAppearance(color: string): { color: string; style: Style } | null {
  const match = /^#([a-f\d]{6})$/i.exec(color.trim());
  if (!match) return null;
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  // Capacitor LIGHT means dark icons on a light background; DARK means light icons.
  return { color: `#${match[1]}`, style: luminance > 0.179 ? Style.Light : Style.Dark };
}

/** Mirror the shared header's background token into Android's native status bar. */
export function installNativeStatusBarBridge(): () => void {
  if (Capacitor.getPlatform() !== "android") return () => {};

  const element = document.documentElement;
  element.dataset.skin = useUIStore.getState().skin;
  let disposed = false;
  let pending = StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
  const sync = () => {
    const appearance = statusBarAppearance(getComputedStyle(element).getPropertyValue("--bg-deepest"));
    if (!appearance) return;
    // Serialize native calls so a slow response cannot restore an older skin.
    pending = pending.then(async () => {
      if (disposed) return;
      await StatusBar.setBackgroundColor({ color: appearance.color });
      await StatusBar.setStyle({ style: appearance.style });
    }).catch(() => { console.warn("Unable to update the Android status bar."); });
  };
  const observer = new MutationObserver(sync);
  observer.observe(element, { attributes: true, attributeFilter: ["data-skin"] });
  const onVisible = () => { if (!document.hidden) sync(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", sync);
  sync();
  return () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", sync);
  };
}

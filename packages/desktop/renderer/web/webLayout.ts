import { useEffect, useState } from "react";

/**
 * Shared responsive-layout helpers for the desktop renderer presentation.
 *
 * Only active when the renderer is mounted by the web shell
 * (packages/webapp sets `document.body.dataset.webShell` before importing
 * App). The Electron desktop app never sets the flag, so every consumer
 * of these helpers is a no-op there.
 */
export function isWebShell(): boolean {
  return typeof document !== "undefined" && document.body.dataset.webShell === "1";
}

/** Track a narrow (phone-width) viewport. */
export function useNarrowViewport(breakpoint = 900): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
  );
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [breakpoint]);
  return narrow;
}

import { useEffect, useState, type RefObject } from "react";

export function useComposerPickerHeight(open: boolean, anchorRef: RefObject<HTMLElement>, direction: "above" | "below" = "above"): number {
  const [maxHeight, setMaxHeight] = useState(420);

  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const updateHeight = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportTop = viewport?.offsetTop ?? 0;
      const availableHeight = direction === "below"
        ? viewportTop + (viewport?.height ?? window.innerHeight) - rect.bottom - 24
        : rect.top - viewportTop - 24;
      setMaxHeight(Math.max(0, Math.min(420, Math.floor(availableHeight))));
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    window.addEventListener("scroll", updateHeight, true);
    viewport?.addEventListener("resize", updateHeight);
    viewport?.addEventListener("scroll", updateHeight);
    return () => {
      window.removeEventListener("resize", updateHeight);
      window.removeEventListener("scroll", updateHeight, true);
      viewport?.removeEventListener("resize", updateHeight);
      viewport?.removeEventListener("scroll", updateHeight);
    };
  }, [open, anchorRef, direction]);

  return maxHeight;
}

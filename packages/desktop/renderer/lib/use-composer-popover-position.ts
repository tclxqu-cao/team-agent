import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { composerPopoverPosition } from "./composer-popover-position";

const useBrowserLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

export function useComposerPopoverPosition(open: boolean, anchor: RefObject<HTMLElement>, menu: RefObject<HTMLElement>): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useBrowserLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const reposition = () => {
      if (!anchor.current || !menu.current) return;
      setPosition(composerPopoverPosition(anchor.current.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      }, menu.current.scrollHeight + menu.current.offsetHeight - menu.current.clientHeight));
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (anchor.current) observer.observe(anchor.current);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    viewport?.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
    };
  }, [open, anchor, menu]);
  return position;
}

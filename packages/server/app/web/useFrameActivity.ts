"use client";
import { useEffect, type RefObject } from "react";
import { PAGE_ACTIVITY, PAGE_ACTIVITY_REQUEST } from "../../../core/src/domain/web-console/PageActivityBridge";

export function useFrameActivity(track: RefObject<HTMLDivElement>, activeId: string | null, visible: boolean) {
  useEffect(() => {
    const frames = () => Array.from(track.current?.querySelectorAll<HTMLIFrameElement>("iframe") ?? []);
    const publish = (frame: HTMLIFrameElement) => {
      const active = visible && !document.hidden
        && frame.closest<HTMLElement>("[data-console-tab]")?.dataset.consoleTab === activeId;
      frame.contentWindow?.postMessage({ type: PAGE_ACTIVITY, active }, window.location.origin);
    };
    const broadcast = () => frames().forEach(publish);
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== PAGE_ACTIVITY_REQUEST) return;
      const frame = frames().find(frame => frame.contentWindow === event.source);
      if (frame) publish(frame);
    };
    window.addEventListener("message", receive);
    document.addEventListener("visibilitychange", broadcast);
    broadcast();
    return () => {
      window.removeEventListener("message", receive);
      document.removeEventListener("visibilitychange", broadcast);
    };
  }, [track, activeId, visible]);
}

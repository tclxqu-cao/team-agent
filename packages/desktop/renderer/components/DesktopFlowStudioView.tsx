import { ArrowLeft, LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedPageRect, FlowStudioEvent } from "../global";

type ViewState = "loading" | "ready" | "error";

interface DesktopFlowStudioViewProps {
  entryUrl: string;
  onBack: () => void;
}

export default function DesktopFlowStudioView({
  entryUrl,
  onBack,
}: DesktopFlowStudioViewProps) {
  const api = typeof window !== "undefined" ? window.agentApi : undefined;
  const available = typeof api?.flowStudioOpen === "function";
  const contentRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef<EmbeddedPageRect | null>(null);
  const [viewState, setViewState] = useState<ViewState>("loading");

  const showAtCurrentBounds = useCallback(() => {
    if (boundsRef.current) void api?.flowStudioSetBounds(boundsRef.current);
  }, [api]);

  const open = useCallback(async () => {
    if (!available || !api) {
      setViewState("error");
      return;
    }
    setViewState("loading");
    const result = await api.flowStudioOpen(entryUrl).catch(() => ({ ok: false }));
    if (!result.ok) {
      setViewState("error");
      return;
    }
    showAtCurrentBounds();
  }, [api, available, entryUrl, showAtCurrentBounds]);

  useEffect(() => {
    if (!available || !api) {
      setViewState("error");
      return;
    }
    const unsubscribe = api.onFlowStudioEvent((event: FlowStudioEvent) => {
      if (event.siteId !== "flow-studio") return;
      if (event.type === "loading") setViewState("loading");
      if (event.type === "loaded") {
        setViewState("ready");
        showAtCurrentBounds();
      }
      if (event.type === "load-failed") setViewState("error");
    });
    void open();
    return () => {
      unsubscribe();
      void api.flowStudioSetBounds(null);
    };
  }, [api, available, open, showAtCurrentBounds]);

  useEffect(() => {
    if (!available || !api) return;
    const element = contentRef.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      boundsRef.current = next;
      void api.flowStudioSetBounds(next);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [api, available]);

  return (
    <section
      className="desktop-flow-studio-view"
      aria-label="Flow Studio"
      aria-busy={viewState === "loading"}
    >
      <header className="desktop-flow-studio-topbar">
        <button
          type="button"
          className="desktop-flow-studio-back ui-icon-button"
          onClick={onBack}
          title="返回 AgentRoam"
          aria-label="返回 AgentRoam"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
      </header>

      <div ref={contentRef} className="desktop-flow-studio-content">
        {viewState !== "ready" && (
          <div
            className="desktop-flow-studio-status"
            role={viewState === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {viewState === "loading" ? (
              <LoaderCircle className="desktop-flow-studio-spinner" size={20} aria-hidden="true" />
            ) : null}
            <strong>{viewState === "error" ? "无法打开 Flow Studio" : "正在打开 Flow Studio"}</strong>
            {viewState === "error" && (
              <button
                type="button"
                className="desktop-flow-studio-retry"
                onClick={() => void open()}
              >
                <RotateCw size={16} aria-hidden="true" />
                <span>重试</span>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

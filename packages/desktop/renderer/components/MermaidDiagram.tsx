import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { clampDiagramScale, exportMermaidPng, fitDiagramScale, getDiagramSize } from "../lib/mermaid-image";

function MermaidDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="mermaid-dialog" data-tab-swipe-ignore ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
      if (event.key !== "Tab") return;
      const targets = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])];
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }}>
      <div className="mermaid-dialog-header">
        <strong>{label}</strong>
        <button type="button" className="mermaid-control" aria-label={`关闭${label}`} onClick={onClose}><X size={20} /></button>
      </div>
      {children}
    </div>,
    document.body,
  );
}

interface MermaidViewportProps {
  svg: string;
  fullscreen: boolean;
  onFullscreen: () => void;
  onExport: () => void;
  exporting: boolean;
}

function MermaidViewport({ svg, fullscreen, onFullscreen, onExport, exporting }: MermaidViewportProps) {
  const size = useMemo(() => getDiagramSize(svg), [svg]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(size);
  const [manualScale, setManualScale] = useState<number | null>(null);
  const fit = fitDiagramScale(size, available.width, fullscreen ? available.height : undefined);
  const scale = manualScale === null ? fit : clampDiagramScale(manualScale, fit);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const dragged = useRef(false);
  const mouseDrag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => setAvailable({ width: Math.max(1, viewport.clientWidth - 24), height: Math.max(1, viewport.clientHeight - 24) });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const zoomAt = useCallback((next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = clampDiagramScale(next, fit);
    const ratio = target / scaleRef.current;
    const center = point ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const left = (viewport.scrollLeft + center.x) * ratio - center.x;
    const top = (viewport.scrollTop + center.y) * ratio - center.y;
    scaleRef.current = target;
    setManualScale(target);
    requestAnimationFrame(() => {
      viewport.scrollLeft = left;
      viewport.scrollTop = top;
    });
  }, [fit]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let pinch: { distance: number; scale: number } | null = null;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => {
      dragged.current = false;
      if (event.touches.length === 2) {
        pinch = { distance: Math.max(1, distance(event.touches)), scale: scaleRef.current };
        dragged.current = true;
      }
    };
    const move = (event: TouchEvent) => {
      dragged.current = true;
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      zoomAt(pinch.scale * distance(event.touches) / pinch.distance, {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2 - bounds.left,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2 - bounds.top,
      });
    };
    const end = () => { pinch = null; };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      zoomAt(scaleRef.current * Math.exp(-event.deltaY * 0.01), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    };
    viewport.addEventListener("touchstart", start, { passive: true });
    viewport.addEventListener("touchmove", move, { passive: false });
    viewport.addEventListener("touchend", end);
    viewport.addEventListener("touchcancel", end);
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      viewport.removeEventListener("touchstart", start);
      viewport.removeEventListener("touchmove", move);
      viewport.removeEventListener("touchend", end);
      viewport.removeEventListener("touchcancel", end);
      viewport.removeEventListener("wheel", wheel);
    };
  }, [zoomAt]);

  return (
    <div className={`mermaid-viewer${fullscreen ? " mermaid-viewer-fullscreen" : ""}`}>
      <div className="mermaid-toolbar" role="toolbar" aria-label="图表操作">
        <button type="button" className="mermaid-control" aria-label="缩小图表" title="缩小" disabled={scale <= Math.min(0.1, fit)} onClick={() => zoomAt(scale / 1.25)}><ZoomOut size={18} /></button>
        <span className="mermaid-zoom-value" aria-label="缩放比例">{Math.round(scale * 100)}%</span>
        <button type="button" className="mermaid-control" aria-label="放大图表" title="放大" disabled={scale >= 4} onClick={() => zoomAt(scale * 1.25)}><ZoomIn size={18} /></button>
        <button type="button" className="mermaid-control" aria-label="自适应图表" title="自适应" onClick={() => { setManualScale(null); viewportRef.current?.scrollTo(0, 0); }}><RotateCcw size={18} /></button>
        <button type="button" className="mermaid-control" aria-label={fullscreen ? "退出图表全屏" : "全屏查看图表"} title={fullscreen ? "退出全屏" : "全屏"} onClick={onFullscreen}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        <button type="button" className="mermaid-control" aria-label="导出图表 PNG" title="导出 PNG" disabled={exporting} onClick={onExport}><Download size={18} /></button>
      </div>
      <div className="mermaid-block-preview" ref={viewportRef} tabIndex={0} aria-label="图表预览，可滚动或双指缩放" onPointerDown={(event) => {
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        const viewport = event.currentTarget;
        dragged.current = false;
        mouseDrag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      }} onPointerMove={(event) => {
        const start = mouseDrag.current;
        if (!start) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
          if (!dragged.current) event.currentTarget.setPointerCapture(event.pointerId);
          dragged.current = true;
        }
        event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
        event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
      }} onPointerUp={() => { mouseDrag.current = null; }} onPointerCancel={() => { mouseDrag.current = null; }}>
        <div
          className="mermaid-diagram-canvas"
          style={{ width: size.width * scale, height: size.height * scale }}
          role={fullscreen ? "img" : "button"}
          aria-label={fullscreen ? "Mermaid 图表" : "点击全屏查看 Mermaid 图表"}
          tabIndex={fullscreen ? undefined : 0}
          onClick={() => { if (!fullscreen && !dragged.current) onFullscreen(); }}
          onKeyDown={(event) => { if (!fullscreen && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFullscreen(); } }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="mermaid-viewer-hint">{exporting ? "正在生成完整 PNG…" : fullscreen ? "双指缩放 · 滑动查看 · 导出完整图片" : "点击图表全屏 · 双指缩放"}</div>
    </div>
  );
}

export default function MermaidDiagram({ code, svg }: { code: string; svg: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    requestAnimationFrame(() => hostRef.current?.querySelector<HTMLButtonElement>('button[aria-label="全屏查看图表"]')?.focus());
  }, []);
  const closeImage = useCallback(() => setImageUrl(null), []);

  useEffect(() => {
    return () => { generation.current++; };
  }, [code]);
  useEffect(() => {
    return () => { if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [imageUrl]);

  const exportImage = async () => {
    if (exporting) return;
    const currentGeneration = generation.current;
    setExporting(true);
    setError(null);
    try {
      const blob = await exportMermaidPng(code);
      if (currentGeneration === generation.current) setImageUrl(URL.createObjectURL(blob));
    } catch (failure) {
      if (currentGeneration === generation.current) setError(failure instanceof Error ? failure.message : "图片导出失败，请重试。");
    } finally {
      if (currentGeneration === generation.current) setExporting(false);
    }
  };

  const viewer = <MermaidViewport svg={svg} fullscreen={fullscreen} onFullscreen={() => fullscreen ? closeFullscreen() : setFullscreen(true)} onExport={() => void exportImage()} exporting={exporting} />;
  return <div className="mermaid-diagram" data-tab-swipe-ignore ref={hostRef}>
    {fullscreen ? <MermaidDialog label="图表全屏" onClose={closeFullscreen}>{viewer}{error && <div className="mermaid-block-status" role="alert">{error}</div>}</MermaidDialog> : viewer}
    {!fullscreen && error && <div className="mermaid-block-status" role="alert">{error}</div>}
    {imageUrl && <MermaidDialog label="导出图表图片" onClose={closeImage}>
      <div className="mermaid-export-actions"><span>手机可长按图片保存，或下载 PNG</span><a href={imageUrl} download="mermaid-diagram.png">下载 PNG</a></div>
      <div className="mermaid-export-preview"><img src={imageUrl} alt="完整 Mermaid 图表 PNG" /></div>
    </MermaidDialog>}
  </div>;
}

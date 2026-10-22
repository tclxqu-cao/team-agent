import { useEffect, useRef, useState } from "react";
import { initialImageViewport, moveImage, zoomImage, type ImagePoint } from "../lib/image-viewport";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface MessageImagePreview {
  src: string;
  alt: string;
}

interface MessageImageLightboxProps {
  image: MessageImagePreview | null;
  onClose: () => void;
}

export default function MessageImageLightbox({ image, onClose }: MessageImageLightboxProps) {
  const [view, setView] = useState(initialImageViewport);
  const surface = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, ImagePoint>());
  const dragged = useRef(false);
  const point = (clientX: number, clientY: number): ImagePoint => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };
  useEffect(() => {
    setView(initialImageViewport());
    pointers.current.clear();
  }, [image?.src]);
  useEffect(() => {
    const element = surface.current;
    if (!image || !element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const anchor = point(event.clientX, event.clientY);
      setView((current) => zoomImage(current, current.scale * Math.exp(-event.deltaY * 0.002), anchor));
    };
    const preventGesture = (event: Event) => event.preventDefault();
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", preventGesture, { passive: false });
    element.addEventListener("gesturechange", preventGesture, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", preventGesture);
      element.removeEventListener("gesturechange", preventGesture);
    };
  }, [image?.src]);
  useEffect(() => {
    if (!image) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [image, onClose]);

  if (!image) return null;

  return createPortal(
    <div
      ref={surface}
      className="message-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={(event) => {
        if (event.target === event.currentTarget && !dragged.current) onClose();
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button") || event.button !== 0) return;
        if (!pointers.current.size) dragged.current = false;
        pointers.current.set(event.pointerId, point(event.clientX, event.clientY));
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        const before = [...pointers.current.values()].slice(0, 2);
        const previous = pointers.current.get(event.pointerId)!;
        const current = point(event.clientX, event.clientY);
        if (Math.hypot(current.x - previous.x, current.y - previous.y) > 2) dragged.current = true;
        pointers.current.set(event.pointerId, current);
        const after = [...pointers.current.values()].slice(0, 2);
        setView((value) => moveImage(value, before, after));
      }}
      onPointerUp={(event) => pointers.current.delete(event.pointerId)}
      onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
      onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
    >
      <img className="message-image-lightbox__image" src={image.src} alt={image.alt} draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
      <div className="message-image-lightbox__toolbar">
        <button type="button" aria-label="缩小图片" disabled={view.scale <= 1} onClick={() => setView((value) => zoomImage(value, value.scale / 1.5))}>−</button>
        <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label="放大图片" disabled={view.scale >= 6} onClick={() => setView((value) => zoomImage(value, value.scale * 1.5))}>+</button>
        <button type="button" onClick={() => setView(initialImageViewport())}>恢复</button>
      </div>
      <button
        type="button"
        className="message-image-lightbox__close"
        onClick={onClose}
        aria-label="关闭图片预览"
        title="关闭"
        autoFocus
      >
        <X size={22} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}

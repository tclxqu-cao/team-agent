export interface VisualViewportLike {
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
}

interface ViewportFallback {
  height: number;
  width: number;
}

export function resolveVisualViewport(
  viewport: VisualViewportLike | null,
  fallback: ViewportFallback,
) {
  return {
    height: Math.round(viewport?.height ?? fallback.height),
    width: Math.round(viewport?.width ?? fallback.width),
    top: Math.round(viewport?.offsetTop ?? 0),
    left: Math.round(viewport?.offsetLeft ?? 0),
  };
}

export function resetHorizontalScroll(target: { scrollLeft: number } | null): void {
  if (target) target.scrollLeft = 0;
}

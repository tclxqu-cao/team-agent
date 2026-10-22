export interface ImageViewport { scale: number; x: number; y: number }
export interface ImagePoint { x: number; y: number }
export const initialImageViewport = (): ImageViewport => ({ scale: 1, x: 0, y: 0 });

export function zoomImage(view: ImageViewport, scale: number, anchor: ImagePoint = { x: 0, y: 0 }): ImageViewport {
  const next = Math.min(6, Math.max(1, scale));
  if (next === 1) return initialImageViewport();
  const ratio = next / view.scale;
  return { scale: next, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio };
}

export function moveImage(view: ImageViewport, before: ImagePoint[], after: ImagePoint[]): ImageViewport {
  if (!before.length || before.length !== after.length) return view;
  const center = (points: ImagePoint[]) => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length });
  const previous = center(before);
  const current = center(after);
  let next = view;
  if (before.length === 2) {
    const distance = (points: ImagePoint[]) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const span = distance(before);
    if (span > 0) next = zoomImage(view, view.scale * distance(after) / span, previous);
  }
  return next.scale === 1 ? next : { ...next, x: next.x + current.x - previous.x, y: next.y + current.y - previous.y };
}

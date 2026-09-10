/** Map a contained screenshot to normalized page coordinates; ignore letterboxing. */
export function chromeFramePoint(x: number, y: number, box: { left: number; top: number; width: number; height: number }, frame: { width: number; height: number }): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  const px = (x - box.left - (box.width - width) / 2) / width;
  const py = (y - box.top - (box.height - height) / 2) / height;
  return px >= 0 && px <= 1 && py >= 0 && py <= 1 ? { x: px, y: py } : null;
}

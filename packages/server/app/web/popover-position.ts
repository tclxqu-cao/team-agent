export function popoverTop(anchor: { top: number; bottom: number }, height: number, viewportHeight: number): number {
  const below = anchor.bottom + 6;
  const preferred = below + height <= viewportHeight - 8 ? below : anchor.top - height - 6;
  return Math.max(8, Math.min(preferred, viewportHeight - height - 8));
}

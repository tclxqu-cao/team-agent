interface AnchorRect { top: number; right: number; bottom: number }
interface ViewportRect { top: number; left: number; width: number; height: number }
interface MenuSize { width?: number; maxHeight?: number }

/** Position a portalled composer menu inside the visible document viewport. */
export function composerPopoverPosition(anchor: AnchorRect, viewport: ViewportRect, contentHeight: number, size: MenuSize = {}) {
  const margin = 16;
  const gap = 8;
  const leftEdge = viewport.left + margin;
  const topEdge = viewport.top + margin;
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  const rightEdge = leftEdge + availableWidth;
  const bottomEdge = topEdge + availableHeight;
  const width = Math.min(size.width ?? 320, availableWidth);
  const above = Math.max(0, anchor.top - topEdge - gap);
  const below = Math.max(0, bottomEdge - anchor.bottom - gap);
  const upwards = above >= Math.min(contentHeight, below);
  const maxHeight = Math.min(size.maxHeight ?? 420, availableHeight, upwards ? above : below);
  const height = Math.min(contentHeight, maxHeight);
  return {
    left: Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width)),
    top: Math.max(topEdge, Math.min(upwards ? anchor.top - height - gap : anchor.bottom + gap, bottomEdge - height)),
    width,
    maxHeight,
  };
}

interface ViewportRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Express the visible part of an embedded document in its own coordinates. */
export function intersectBrowserLiveViewport(
  local: ViewportRect,
  parent: ViewportRect,
  frame: ViewportRect,
): ViewportRect {
  const top = Math.max(local.top, parent.top - frame.top);
  const left = Math.max(local.left, parent.left - frame.left);
  const bottom = Math.min(local.top + local.height, parent.top + parent.height - frame.top);
  const right = Math.min(local.left + local.width, parent.left + parent.width - frame.left);
  return { top, left, height: Math.max(0, bottom - top), width: Math.max(0, right - left) };
}

function readViewport(view: Window): ViewportRect {
  const viewport = view.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? view.innerWidth,
    height: viewport?.height ?? view.innerHeight,
  };
}

/** Safari can shrink/pan the top viewport while an iframe keeps its layout size. */
export function trackBrowserLiveViewport(
  element: HTMLElement,
  view: Window = window,
  fitFrame = false,
): () => void {
  let parent: Window | null = null;
  let frame: Element | null = null;
  try {
    if (view.parent !== view && view.parent.location.origin === view.location.origin) {
      parent = view.parent;
      frame = view.frameElement;
    }
  } catch {
    // Cross-origin embedding can only use the local viewport.
  }

  let animationFrame: number | null = null;
  let settleTimer: number | null = null;
  const sync = () => {
    let viewport = readViewport(view);
    // Native fullscreen escapes the iframe; in-page fullscreen stays inside it.
    if (parent && frame && !view.document.fullscreenElement) {
      // The shell already follows the top-level visual viewport. Safari can
      // report that keyboard pan again inside the iframe; applying it locally
      // leaves a blank strip and clips the picture twice. Only the parent
      // defines keyboard occlusion; the frame contributes its layout bounds.
      const local = { top: 0, left: 0, width: view.innerWidth, height: view.innerHeight };
      // RemoteDesktopPage's shell already sizes and positions this iframe to
      // the visual viewport. WebKit can report its pan in frame geometry too;
      // clipping that frame again leaves a blank strip above the panel.
      viewport = fitFrame ? local : intersectBrowserLiveViewport(local, readViewport(parent), frame.getBoundingClientRect());
    }
    for (const [name, value] of Object.entries(viewport)) {
      element.style.setProperty(`--browser-live-${name}`, `${value}px`);
    }
  };
  const schedule = () => {
    if (animationFrame !== null) view.cancelAnimationFrame(animationFrame);
    animationFrame = view.requestAnimationFrame(() => {
      animationFrame = null;
      sync();
    });
    if (settleTimer !== null) view.clearTimeout(settleTimer);
    settleTimer = view.setTimeout(sync, 250);
  };
  const sources: EventTarget[] = [view, view.document];
  if (view.visualViewport) sources.push(view.visualViewport);
  if (parent) {
    sources.push(parent);
    sources.push(parent.document);
    if (parent.visualViewport) sources.push(parent.visualViewport);
  }
  // The shell slides tabs with a transform. Recompute once the frame reaches
  // its final position; measuring mid-transition would leave the view clipped.
  const events = ["resize", "scroll", "orientationchange", "pageshow", "visibilitychange", "fullscreenchange", "transitionend"];
  for (const source of sources) {
    for (const event of events) source.addEventListener(event, schedule);
  }
  const observer = frame && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
  if (frame) observer?.observe(frame);
  sync();
  return () => {
    for (const source of sources) {
      for (const event of events) source.removeEventListener(event, schedule);
    }
    if (animationFrame !== null) view.cancelAnimationFrame(animationFrame);
    if (settleTimer !== null) view.clearTimeout(settleTimer);
    observer?.disconnect();
    for (const name of ["top", "left", "width", "height"]) {
      element.style.removeProperty(`--browser-live-${name}`);
    }
  };
}

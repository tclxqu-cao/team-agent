export const WEBAPP_TAB_SWIPE_MESSAGE_TYPE = "agent-webapp:tab-swipe:v1";

export type ParentTabSwipePhase = "move" | "end" | "cancel";

export interface ParentTabSwipeMessage {
  type: typeof WEBAPP_TAB_SWIPE_MESSAGE_TYPE;
  phase: ParentTabSwipePhase;
  deltaX: number;
}

interface PointerSample {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  viewportWidth: number;
  interactive?: boolean;
}

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
  axis: "pending" | "horizontal";
}

export interface ParentTabSwipeGesture {
  pointerDown(sample: PointerSample): void;
  pointerMove(sample: PointerSample): boolean;
  pointerUp(sample: PointerSample): boolean;
  pointerCancel(sample: PointerSample): boolean;
}

const INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable='true']",
  "[role='button']",
  "[data-tab-swipe-ignore]",
].join(",");

export const TAB_SWIPE_EDGE_WIDTH_PX = 24;

export function isParentTabSwipeInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  return Boolean((target as Element).closest(INTERACTIVE_SELECTOR));
}

export function createParentTabSwipeGesture(
  emit: (message: ParentTabSwipeMessage) => void,
): ParentTabSwipeGesture {
  let active: ActiveGesture | null = null;

  const matchesActivePointer = (sample: PointerSample) =>
    active !== null && sample.pointerType === "touch" && sample.pointerId === active.pointerId;

  return {
    pointerDown(sample) {
      if (sample.pointerType !== "touch" || !sample.isPrimary || sample.interactive) return;
      const startsAtViewportEdge = sample.clientX <= TAB_SWIPE_EDGE_WIDTH_PX
        || sample.clientX >= sample.viewportWidth - TAB_SWIPE_EDGE_WIDTH_PX;
      if (!startsAtViewportEdge) return;
      active = {
        pointerId: sample.pointerId,
        startX: sample.clientX,
        startY: sample.clientY,
        axis: "pending",
      };
    },

    pointerMove(sample) {
      if (!matchesActivePointer(sample) || !active) return false;
      const deltaX = sample.clientX - active.startX;
      const deltaY = sample.clientY - active.startY;

      if (active.axis === "pending") {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) <= 8) return false;
        if (Math.abs(deltaY) >= Math.abs(deltaX) * 1.2) {
          active = null;
          return false;
        }
        active.axis = "horizontal";
      }

      emit({ type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "move", deltaX });
      return true;
    },

    pointerUp(sample) {
      if (!matchesActivePointer(sample) || !active) return false;
      const handled = active.axis === "horizontal";
      if (handled) {
        emit({
          type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
          phase: "end",
          deltaX: sample.clientX - active.startX,
        });
      }
      active = null;
      return handled;
    },

    pointerCancel(sample) {
      if (!matchesActivePointer(sample) || !active) return false;
      const handled = active.axis === "horizontal";
      if (handled) {
        emit({ type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "cancel", deltaX: 0 });
      }
      active = null;
      return handled;
    },
  };
}

export function installParentTabSwipeBridge(): () => void {
  if (window.parent === window) return () => {};

  const gesture = createParentTabSwipeGesture((message) => {
    window.parent.postMessage(message, window.location.origin);
  });
  const sample = (event: PointerEvent): PointerSample => ({
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    clientX: event.clientX,
    clientY: event.clientY,
    viewportWidth: window.innerWidth,
  });
  const onPointerDown = (event: PointerEvent) => {
    gesture.pointerDown({
      ...sample(event),
      interactive: isParentTabSwipeInteractiveTarget(event.target),
    });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (gesture.pointerMove(sample(event))) event.preventDefault();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (gesture.pointerUp(sample(event))) event.preventDefault();
  };
  const onPointerCancel = (event: PointerEvent) => {
    gesture.pointerCancel(sample(event));
  };

  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  document.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  document.addEventListener("pointercancel", onPointerCancel, { capture: true });

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    document.removeEventListener("pointerup", onPointerUp, { capture: true });
    document.removeEventListener("pointercancel", onPointerCancel, { capture: true });
  };
}

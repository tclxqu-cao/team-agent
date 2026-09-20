export interface PaintTarget {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  setTimeout(callback: () => void, delay?: number): number;
  clearTimeout(timerId: number): void;
}

/** Let React commit and the browser paint optimistic UI before work resumes. */
export function waitForNextPaint(target: PaintTarget = window): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let fallbackId: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackId !== undefined) target.clearTimeout(fallbackId);
      resolve();
    };

    fallbackId = target.setTimeout(finish, 100);
    target.requestAnimationFrame(() => {
      target.setTimeout(finish, 0);
    });
  });
}

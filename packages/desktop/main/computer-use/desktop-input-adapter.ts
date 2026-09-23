import { ComputerOperationError } from "@agent/computer-use";
import type { DesktopInputCommand } from "../desktop-input-gateway.js";
import type { DesktopCapturedFrame } from "../desktop-screen-screencast.js";

export interface ComputerInputGateway {
  dispatch(command: DesktopInputCommand): Promise<unknown>;
}

const MODIFIER_ALIASES: Record<string, "Meta" | "Control" | "Alt" | "Shift"> = {
  meta: "Meta",
  command: "Meta",
  cmd: "Meta",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

function keyCode(value: string): string {
  if (/^Key[A-Z]$/.test(value) || /^Digit\d$/.test(value)) return value;
  if (/^[a-z]$/i.test(value)) return `Key${value.toUpperCase()}`;
  if (/^\d$/.test(value)) return `Digit${value}`;
  const aliases: Record<string, string> = {
    return: "Enter",
    esc: "Escape",
    spacebar: "Space",
    deleteforward: "Delete",
  };
  return aliases[value.toLowerCase()] ?? value;
}

export function screenshotPoint(frame: DesktopCapturedFrame, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new ComputerOperationError(
      "stale_observation",
      "Screenshot coordinates are outside the latest frame",
      "Capture a fresh screenshot and use coordinates inside its pixel dimensions.",
    );
  }
  return {
    x: frame.originX + Math.min(frame.logicalWidth - 1, Math.round((x / frame.width) * frame.logicalWidth)),
    y: frame.originY + Math.min(frame.logicalHeight - 1, Math.round((y / frame.height) * frame.logicalHeight)),
  };
}

export class DesktopInputAdapter {
  constructor(private readonly gateway: ComputerInputGateway) {}

  move(x: number, y: number): Promise<unknown> {
    return this.gateway.dispatch({ op: "move", x, y });
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left", count = 1): Promise<void> {
    await this.gateway.dispatch({ op: "down", x, y, button, click: count });
    await this.gateway.dispatch({ op: "up", x, y, button, click: count });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.move(x, y);
    await this.gateway.dispatch({ op: "wheel", deltaX, deltaY });
  }

  type(text: string): Promise<unknown> {
    return this.gateway.dispatch({ op: "unicode_text", text });
  }

  async keypress(keys: string[]): Promise<void> {
    const modifiers: Array<"Meta" | "Control" | "Alt" | "Shift"> = [];
    let primary = "";
    for (const key of keys) {
      const modifier = MODIFIER_ALIASES[key.toLowerCase()];
      if (modifier) modifiers.push(modifier);
      else primary = keyCode(key);
    }
    if (!primary) {
      throw new ComputerOperationError("action_not_supported", "keypress requires one non-modifier key");
    }
    const uniqueModifiers = [...new Set(modifiers)];
    await this.gateway.dispatch({ op: "key", action: "down", code: primary, modifiers: uniqueModifiers });
    await this.gateway.dispatch({ op: "key", action: "up", code: primary, modifiers: uniqueModifiers });
  }

  async drag(
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    signal?: AbortSignal,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ): Promise<void> {
    await this.gateway.dispatch({ op: "down", x: start.x, y: start.y, button: "left", click: 1 });
    let released = false;
    try {
      const steps = Math.max(1, Math.min(30, Math.ceil(durationMs / 25)));
      for (let step = 1; step <= steps; step++) {
        if (signal?.aborted) throw new ComputerOperationError("aborted", "Computer drag was aborted after pointer down");
        const ratio = step / steps;
        await this.gateway.dispatch({
          op: "drag",
          x: Math.round(start.x + (end.x - start.x) * ratio),
          y: Math.round(start.y + (end.y - start.y) * ratio),
        });
        if (step < steps && durationMs > 0) await sleep(durationMs / steps);
      }
      await this.gateway.dispatch({ op: "up", x: end.x, y: end.y, button: "left", click: 1 });
      released = true;
    } finally {
      if (!released) {
        await this.gateway.dispatch({ op: "up", x: end.x, y: end.y, button: "left", click: 1 }).catch(() => undefined);
      }
    }
  }
}

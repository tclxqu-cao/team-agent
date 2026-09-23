import {
  COMPUTER_RELAY_PROTOCOL_VERSION,
  ComputerOperationError,
  ObservationSelectionPolicy,
  isMutatingComputerAction,
  type AccessibilityNode,
  type AccessibilityObservation,
  type ComputerAction,
  type ComputerObservation,
  type ComputerRuntimePort,
  type ComputerRuntimeStatus,
} from "@agent/computer-use";
import type { LiveViewOwnershipState } from "@agent/core";
import { DesktopInputAdapter, screenshotPoint } from "./desktop-input-adapter.js";
import { ElectronScreenCaptureAdapter } from "./electron-screen-capture-adapter.js";
import { MacAccessibilityAdapter } from "./mac-accessibility-adapter.js";

const USER_OWNED_STATES = new Set<LiveViewOwnershipState>([
  "handoff-requested",
  "user-controlled",
  "return-requested",
  "resyncing",
]);

let globalActionTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = globalActionTail.catch(() => undefined).then(operation);
  globalActionTail = result.then(() => undefined, () => undefined);
  return result;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ComputerOperationError("aborted", "Computer action was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new ComputerOperationError("aborted", "Computer action was aborted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function runtimeError(error: unknown): ComputerOperationError {
  if (error instanceof ComputerOperationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return new ComputerOperationError("action_timeout", message);
  if (/not running|stopped|exited|ENOENT|ECONNREFUSED/i.test(message)) {
    return new ComputerOperationError("desktop_offline", message);
  }
  return new ComputerOperationError("action_not_supported", message);
}

export interface DesktopComputerRuntimeOptions {
  accessibility: MacAccessibilityAdapter;
  screenCapture: ElectronScreenCaptureAdapter;
  input: DesktopInputAdapter;
  ownership: () => LiveViewOwnershipState | null;
  locked?: () => boolean;
  platform?: NodeJS.Platform;
  settleMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class DesktopComputerRuntime implements ComputerRuntimePort {
  private readonly policy = new ObservationSelectionPolicy();
  private readonly platform: NodeJS.Platform;
  private readonly settleMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private latestAccessibility: AccessibilityObservation | null = null;

  constructor(private readonly options: DesktopComputerRuntimeOptions) {
    this.platform = options.platform ?? process.platform;
    this.settleMs = options.settleMs ?? 80;
    this.sleep = options.sleep ?? sleepWithAbort;
  }

  async status(): Promise<ComputerRuntimeStatus> {
    if (this.platform !== "darwin") {
      return { available: false, platform: this.platform, protocolVersion: COMPUTER_RELAY_PROTOCOL_VERSION };
    }
    const [accessibility, screenRecording] = await Promise.all([
      this.options.accessibility.isTrusted(),
      Promise.resolve(this.options.screenCapture.isAuthorized()),
    ]);
    return {
      available: true,
      platform: "darwin",
      protocolVersion: COMPUTER_RELAY_PROTOCOL_VERSION,
      desktopLocked: this.isLocked(),
      accessibility,
      screenRecording,
      vision: screenRecording,
    };
  }

  execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation> {
    return serialize(async () => {
      if (signal?.aborted) throw new ComputerOperationError("aborted", "Computer action was aborted");
      try {
        return await this.executeSerialized(action, signal);
      } catch (error) {
        throw runtimeError(error);
      }
    });
  }

  private async executeSerialized(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation> {
    if (action.action === "wait") {
      await this.sleep(action.durationMs, signal);
      this.assertUnlocked();
      return this.observe();
    }
    this.assertUnlocked();
    if (action.action === "observe") return this.observe();
    if (action.action === "screenshot") return this.options.screenCapture.capture("explicit");

    this.assertAgentOwnsDesktop(action);
    await this.options.accessibility.ensureTrusted();

    switch (action.action) {
      case "press":
        this.requireNode(action.revision, action.nodeId);
        await this.options.accessibility.perform(action.revision, action.nodeId, "press");
        break;
      case "click":
      case "double_click":
        await this.click(action, signal);
        break;
      case "type":
        this.requireNode(action.revision, action.nodeId);
        await this.options.accessibility.perform(action.revision, action.nodeId, "focus");
        try {
          await this.options.accessibility.setText(action.revision, action.nodeId, action.text, action.replace === true);
        } catch (error) {
          if (!(error instanceof ComputerOperationError) || error.code !== "action_not_supported") throw error;
          if (action.replace) await this.options.input.keypress(["Meta", "KeyA"]);
          await this.options.input.type(action.text);
        }
        break;
      case "keypress":
        await this.options.input.keypress(action.keys);
        break;
      case "scroll":
        await this.scroll(action);
        break;
      case "move": {
        const point = this.latestScreenshotPoint(action.x, action.y);
        await this.options.input.move(point.x, point.y);
        break;
      }
      case "drag": {
        const start = this.latestScreenshotPoint(action.startX, action.startY);
        const end = this.latestScreenshotPoint(action.endX, action.endY);
        await this.options.input.drag(start, end, action.durationMs ?? 250, signal);
        break;
      }
    }

    if (signal?.aborted) throw new ComputerOperationError("aborted", "Computer action may have completed before cancellation");
    await this.sleep(this.settleMs, signal);
    return this.observe();
  }

  private async observe(): Promise<ComputerObservation> {
    this.assertUnlocked();
    const selection = this.policy.select(await this.options.accessibility.snapshot());
    if (selection.kind === "accessibility") {
      this.latestAccessibility = selection.observation;
      return selection.observation;
    }
    return this.options.screenCapture.capture(selection.reason);
  }

  private assertAgentOwnsDesktop(action: ComputerAction): void {
    if (!isMutatingComputerAction(action)) return;
    const ownership = this.options.ownership();
    if (!ownership || !USER_OWNED_STATES.has(ownership)) return;
    throw new ComputerOperationError(
      "desktop_controlled_by_user",
      `Desktop mutation is blocked while ownership is ${ownership}`,
      "Wait for the user to return desktop control, then observe again.",
    );
  }

  private isLocked(): boolean {
    try {
      return this.options.locked?.() === true;
    } catch {
      return true;
    }
  }

  private assertUnlocked(): void {
    if (!this.isLocked()) return;
    throw new ComputerOperationError(
      "desktop_locked",
      "The macOS desktop is locked",
      "Unlock the Mac, bring the target application to the foreground, then observe again.",
    );
  }

  private requireNode(revision: string, nodeId: string): AccessibilityNode {
    const observation = this.latestAccessibility;
    if (!observation || observation.revision !== revision) {
      throw new ComputerOperationError(
        "stale_observation",
        "Accessibility observation is stale",
        "Call computer with action=observe and use a node from the new revision.",
      );
    }
    const node = observation.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new ComputerOperationError("node_not_found", "Accessibility node is not present in the current observation");
    }
    return node;
  }

  private async click(
    action: Extract<ComputerAction, { action: "click" | "double_click" }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const count = action.action === "double_click" ? 2 : 1;
    if ("nodeId" in action) {
      const node = this.requireNode(action.revision, action.nodeId);
      if ((action.button ?? "left") === "left") {
        try {
          for (let index = 0; index < count; index++) {
            await this.options.accessibility.perform(action.revision, action.nodeId, "press");
          }
          return;
        } catch (error) {
          if (!(error instanceof ComputerOperationError) || error.code !== "action_not_supported") throw error;
        }
      }
      if (!node.bounds) throw new ComputerOperationError("action_not_supported", "Accessibility node has no clickable bounds");
      await this.options.input.click(
        Math.round(node.bounds.x + node.bounds.width / 2),
        Math.round(node.bounds.y + node.bounds.height / 2),
        action.button,
        count,
      );
      return;
    }
    if (signal?.aborted) throw new ComputerOperationError("aborted", "Computer click was aborted");
    const point = this.latestScreenshotPoint(action.x, action.y);
    await this.options.input.click(point.x, point.y, action.button, count);
  }

  private async scroll(action: Extract<ComputerAction, { action: "scroll" }>): Promise<void> {
    let point: { x: number; y: number };
    if ("nodeId" in action) {
      const node = this.requireNode(action.revision, action.nodeId);
      if (!node.bounds) throw new ComputerOperationError("action_not_supported", "Accessibility node has no scroll bounds");
      point = {
        x: Math.round(node.bounds.x + node.bounds.width / 2),
        y: Math.round(node.bounds.y + node.bounds.height / 2),
      };
    } else {
      point = this.latestScreenshotPoint(action.x, action.y);
    }
    await this.options.input.scroll(point.x, point.y, action.deltaX ?? 0, action.deltaY);
  }

  private latestScreenshotPoint(x: number, y: number): { x: number; y: number } {
    const frame = this.options.screenCapture.latestFrame();
    if (!frame) {
      throw new ComputerOperationError(
        "stale_observation",
        "No screenshot is available for coordinate input",
        "Call computer with action=screenshot before using coordinates.",
      );
    }
    return screenshotPoint(frame, x, y);
  }
}

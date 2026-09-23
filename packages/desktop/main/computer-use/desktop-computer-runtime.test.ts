import { describe, expect, it, vi } from "vitest";
import { ComputerOperationError, type AccessibilityObservation, type AccessibilitySnapshotResult } from "@agent/computer-use";
import type { DesktopInputCommand } from "../desktop-input-gateway";
import { DesktopComputerRuntime } from "./desktop-computer-runtime";
import { DesktopInputAdapter } from "./desktop-input-adapter";
import { ElectronScreenCaptureAdapter } from "./electron-screen-capture-adapter";
import { MacAccessibilityAdapter } from "./mac-accessibility-adapter";

const observation = (revision: string, nodes: AccessibilityObservation["nodes"] = [{
  id: `${revision}:1`,
  role: "AXButton",
  name: "Save",
  bounds: { x: 100, y: 200, width: 40, height: 20 },
  actions: ["AXPress"],
}]): AccessibilityObservation => ({
  source: "accessibility",
  revision,
  coverage: "complete",
  app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 },
  nodes,
});

class FakeGateway {
  trusted = true;
  snapshots: AccessibilitySnapshotResult[] = [{ status: "ok", observation: observation("ax_1") }];
  commands: DesktopInputCommand[] = [];
  actions: Array<{ revision: string; nodeId: string; action: "press" | "focus" }> = [];
  textActions: Array<{ revision: string; nodeId: string; text: string; replace: boolean }> = [];
  actionError: ComputerOperationError | null = null;
  textError: ComputerOperationError | null = null;
  async start() {}
  async checkAccessibility() { return this.trusted; }
  async snapshotAccessibility() { return this.snapshots.shift() ?? { status: "ok" as const, observation: observation("ax_tail") }; }
  async performAccessibilityAction(revision: string, nodeId: string, action: "press" | "focus") {
    if (this.actionError) throw this.actionError;
    this.actions.push({ revision, nodeId, action });
  }
  async setAccessibilityText(revision: string, nodeId: string, text: string, replace: boolean) {
    if (this.textError) throw this.textError;
    this.textActions.push({ revision, nodeId, text, replace });
  }
  async dispatch(command: DesktopInputCommand) { this.commands.push(command); return {}; }
}

function fixture(options: {
  gateway?: FakeGateway;
  ownership?: () => "agent-controlled" | "user-controlled" | "resyncing" | null;
  locked?: () => boolean;
  screenPermission?: () => "granted" | "denied";
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}) {
  const gateway = options.gateway ?? new FakeGateway();
  const captureSources = vi.fn(async () => [{
    id: "screen:2",
    thumbnail: {
      toJPEG: () => Buffer.alloc(64, 0x7f),
      getSize: () => ({ width: 200, height: 100 }),
    },
  }]);
  const screenCapture = new ElectronScreenCaptureAdapter({
    displayInfo: () => ({ id: "screen:2", originX: -1000, originY: 100, width: 1000, height: 500, scaleFactor: 2 }),
    captureSources,
    screenPermission: options.screenPermission ?? (() => "granted"),
  });
  const runtime = new DesktopComputerRuntime({
    accessibility: new MacAccessibilityAdapter(gateway),
    screenCapture,
    input: new DesktopInputAdapter(gateway),
    ownership: options.ownership ?? (() => "agent-controlled"),
    locked: options.locked,
    settleMs: 0,
    sleep: options.sleep ?? (async () => undefined),
  });
  return { gateway, captureSources, screenCapture, runtime };
}

describe("DesktopComputerRuntime", () => {
  it("prefers meaningful Accessibility and preserves partial observations", async () => {
    const gateway = new FakeGateway();
    gateway.snapshots = [{ status: "ok", observation: { ...observation("ax_partial"), coverage: "partial" } }];
    const { runtime, captureSources } = fixture({ gateway });
    await expect(runtime.execute({ action: "observe" })).resolves.toMatchObject({
      source: "accessibility",
      revision: "ax_partial",
      coverage: "partial",
    });
    expect(captureSources).not.toHaveBeenCalled();
  });

  it("falls back to a bounded screenshot when Accessibility is unusable", async () => {
    const gateway = new FakeGateway();
    gateway.snapshots = [{ status: "unavailable", message: "no root" }];
    const { runtime } = fixture({ gateway });
    const result = await runtime.execute({ action: "observe" });
    expect(result).toMatchObject({
      source: "screenshot",
      reason: "no_usable_accessibility",
      image: { width: 200, height: 100, logicalWidth: 1000, originX: -1000 },
    });
    expect(result.source === "screenshot" && result.image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("converts screenshot pixels to the selected display's global logical coordinates", async () => {
    const { runtime, gateway } = fixture();
    await runtime.execute({ action: "screenshot" });
    await runtime.execute({ action: "click", x: 100, y: 50 });
    expect(gateway.commands.slice(0, 2)).toEqual([
      { op: "down", x: -500, y: 350, button: "left", click: 1 },
      { op: "up", x: -500, y: 350, button: "left", click: 1 },
    ]);
  });

  it("focuses before replacing text and returns a fresh revision", async () => {
    const gateway = new FakeGateway();
    gateway.snapshots = [
      { status: "ok", observation: observation("ax_1", [{ id: "ax_1:field", role: "AXTextField", name: "Message", actions: [] }]) },
      { status: "ok", observation: observation("ax_2") },
    ];
    const { runtime } = fixture({ gateway });
    await runtime.execute({ action: "observe" });
    await expect(runtime.execute({ action: "type", revision: "ax_1", nodeId: "ax_1:field", text: "hello", replace: true }))
      .resolves.toMatchObject({ revision: "ax_2" });
    expect(gateway.actions).toEqual([{ revision: "ax_1", nodeId: "ax_1:field", action: "focus" }]);
    expect(gateway.textActions).toEqual([
      { revision: "ax_1", nodeId: "ax_1:field", text: "hello", replace: true },
    ]);
    expect(gateway.commands).toEqual([]);
    await expect(runtime.execute({ action: "press", revision: "ax_1", nodeId: "ax_1:field" }))
      .rejects.toMatchObject({ code: "stale_observation" });
  });

  it("falls back to literal Unicode events when a focused node is not AX-writable", async () => {
    const gateway = new FakeGateway();
    gateway.snapshots = [
      { status: "ok", observation: observation("ax_1", [{ id: "ax_1:field", role: "AXTextField", name: "Message", actions: [] }]) },
      { status: "ok", observation: observation("ax_2") },
    ];
    gateway.textError = new ComputerOperationError("action_not_supported", "AXValue is not writable");
    const { runtime } = fixture({ gateway });
    await runtime.execute({ action: "observe" });
    await runtime.execute({ action: "type", revision: "ax_1", nodeId: "ax_1:field", text: "AgentRoam 你好", replace: true });
    expect(gateway.commands).toEqual([
      { op: "key", action: "down", code: "KeyA", modifiers: ["Meta"] },
      { op: "key", action: "up", code: "KeyA", modifiers: ["Meta"] },
      { op: "unicode_text", text: "AgentRoam 你好" },
    ]);
  });

  it("falls back from unsupported AXPress to the node center", async () => {
    const gateway = new FakeGateway();
    gateway.actionError = new ComputerOperationError("action_not_supported", "no AXPress");
    const { runtime } = fixture({ gateway });
    await runtime.execute({ action: "observe" });
    await runtime.execute({ action: "click", revision: "ax_1", nodeId: "ax_1:1" });
    expect(gateway.commands.slice(0, 2)).toEqual([
      { op: "down", x: 120, y: 210, button: "left", click: 1 },
      { op: "up", x: 120, y: 210, button: "left", click: 1 },
    ]);
  });

  it("allows observation but rejects mutation while a phone owns the desktop", async () => {
    const { runtime } = fixture({ ownership: () => "user-controlled" });
    await expect(runtime.execute({ action: "observe" })).resolves.toMatchObject({ source: "accessibility" });
    await expect(runtime.execute({ action: "keypress", keys: ["Enter"] }))
      .rejects.toMatchObject({ code: "desktop_controlled_by_user" });
  });

  it("reports live macOS permission status", async () => {
    const { runtime } = fixture();
    await expect(runtime.status()).resolves.toEqual({
      available: true,
      platform: "darwin",
      protocolVersion: 1,
      desktopLocked: false,
      accessibility: true,
      screenRecording: true,
      vision: true,
    });
  });

  it("fails closed before observing or mutating a locked desktop", async () => {
    const { runtime, gateway, captureSources } = fixture({ locked: () => true });
    await expect(runtime.status()).resolves.toMatchObject({ available: true, desktopLocked: true });
    await expect(runtime.execute({ action: "observe" })).rejects.toMatchObject({
      code: "desktop_locked",
      recovery: expect.stringContaining("Unlock"),
    });
    await expect(runtime.execute({ action: "keypress", keys: ["Enter"] }))
      .rejects.toMatchObject({ code: "desktop_locked" });
    expect(gateway.snapshots).toHaveLength(1);
    expect(gateway.commands).toEqual([]);
    expect(captureSources).not.toHaveBeenCalled();
  });

  it("rechecks lock state after wait before observing", async () => {
    let locked = true;
    const { runtime } = fixture({
      locked: () => locked,
      sleep: async () => { locked = false; },
    });
    await expect(runtime.execute({ action: "wait", durationMs: 1 }))
      .resolves.toMatchObject({ source: "accessibility" });
  });

  it("serializes actions globally across runtime instances", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      const first = fixture({
        sleep: async () => {
          order.push("first:start");
          resolve();
          await new Promise<void>((release) => { releaseFirst = release; });
          order.push("first:end");
        },
      });
      void first.runtime.execute({ action: "wait", durationMs: 1 }).then(() => order.push("first:done"));
    });
    await firstStarted;
    const second = fixture({ sleep: async () => { order.push("second:start"); } });
    const secondRun = second.runtime.execute({ action: "wait", durationMs: 1 }).then(() => order.push("second:done"));
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await secondRun;
    expect(order).toEqual(["first:start", "first:end", "first:done", "second:start", "second:done"]);
  });

  it("cancels an in-flight wait without observing afterward", async () => {
    const controller = new AbortController();
    const { runtime, gateway } = fixture({
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ComputerOperationError("aborted", "cancelled")), { once: true });
      }),
    });
    const pending = runtime.execute({ action: "wait", durationMs: 5_000 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(gateway.snapshots).toHaveLength(1);
  });

  it("returns permission-specific failures without dispatching input", async () => {
    const gateway = new FakeGateway();
    gateway.trusted = false;
    const deniedAccessibility = fixture({ gateway });
    await expect(deniedAccessibility.runtime.execute({ action: "keypress", keys: ["Enter"] }))
      .rejects.toMatchObject({ code: "accessibility_denied" });
    expect(gateway.commands).toEqual([]);

    const deniedCapture = fixture({ screenPermission: () => "denied" });
    await expect(deniedCapture.runtime.execute({ action: "screenshot" }))
      .rejects.toMatchObject({ code: "screen_recording_denied" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { DesktopInputGateway, type InputGatewayProcess } from "./desktop-input-gateway";

class FakeHelperProcess implements InputGatewayProcess {
  readonly written: string[] = [];
  exitCode: number | null = null;
  private stdoutListeners: Array<(chunk: Buffer) => void> = [];
  private stderrListeners: Array<(chunk: Buffer) => void> = [];
  private exitListeners: Array<(code: number | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  killed = false;

  stdin = { write: (chunk: string) => { this.written.push(chunk); } };
  stdout = { on: (_event: "data", listener: (chunk: Buffer) => void) => { this.stdoutListeners.push(listener); } };
  stderr = { on: (_event: "data", listener: (chunk: Buffer) => void) => { this.stderrListeners.push(listener); } };
  on = ((event: "exit" | "error", listener: (payload: number | null | Error) => void) => {
    if (event === "exit") this.exitListeners.push(listener as (code: number | null) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }) as InputGatewayProcess["on"];
  kill() { this.killed = true; this.exitListeners.forEach((listener) => listener(0)); }

  emitLine(line: string) {
    this.stdoutListeners.forEach((listener) => listener(Buffer.from(`${line}\n`)));
  }
  emitStderr(line: string) {
    this.stderrListeners.forEach((listener) => listener(Buffer.from(line)));
  }
  emitError(error: Error) {
    this.errorListeners.forEach((listener) => listener(error));
  }
}

describe("DesktopInputGateway", () => {
  it("writes JSON-lines commands and resolves on helper replies", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const dispatching = gateway.dispatch({ op: "down", x: 120, y: 80, button: "left" });
    const request = JSON.parse(child.written[0]);
    expect(request).toMatchObject({ id: 1, op: "down", x: 120, y: 80, button: "left" });
    child.emitLine(JSON.stringify({ id: 1, ok: true }));
    await expect(dispatching).resolves.toMatchObject({ ok: true });
    await gateway.stop();
    expect(child.killed).toBe(true);
  });

  it("keeps literal Unicode typing distinct from physical-key text input", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const dispatching = gateway.dispatch({ op: "unicode_text", text: "AgentRoam 你好" });
    expect(JSON.parse(child.written[0])).toMatchObject({
      id: 1,
      op: "unicode_text",
      text: "AgentRoam 你好",
    });
    child.emitLine(JSON.stringify({ id: 1, ok: true }));
    await expect(dispatching).resolves.toMatchObject({ ok: true });
    await gateway.stop();
  });

  it("reports accessibility trust from the check command", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const checking = gateway.checkAccessibility();
    child.emitLine(JSON.stringify({ id: 1, ok: true, trusted: false }));
    await expect(checking).resolves.toBe(false);
    await gateway.stop();
  });

  it("shares the persistent helper with AX snapshots and revision-bound actions", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const snapshot = gateway.snapshotAccessibility();
    expect(JSON.parse(child.written[0])).toMatchObject({ id: 1, op: "ax_snapshot" });
    child.emitLine(JSON.stringify({
      id: 1,
      ok: true,
      status: "ok",
      observation: {
        source: "accessibility",
        revision: "ax_1",
        coverage: "complete",
        app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 },
        nodes: [],
      },
    }));
    await expect(snapshot).resolves.toMatchObject({ status: "ok", observation: { revision: "ax_1" } });

    const pressing = gateway.performAccessibilityAction("ax_1", "ax_1:1", "press");
    expect(JSON.parse(child.written[1])).toMatchObject({
      id: 2,
      op: "ax_action",
      revision: "ax_1",
      nodeId: "ax_1:1",
      action: "press",
    });
    child.emitLine(JSON.stringify({ id: 2, ok: true }));
    await expect(pressing).resolves.toBeUndefined();

    const typing = gateway.setAccessibilityText("ax_1", "ax_1:2", "AgentRoam 你好", true);
    expect(JSON.parse(child.written[2])).toMatchObject({
      id: 3,
      op: "ax_text",
      revision: "ax_1",
      nodeId: "ax_1:2",
      text: "AgentRoam 你好",
      replace: true,
    });
    child.emitLine(JSON.stringify({ id: 3, ok: true }));
    await expect(typing).resolves.toBeUndefined();
    await gateway.stop();
  });

  it("preserves structured helper errors", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const pressing = gateway.performAccessibilityAction("old", "old:1", "press");
    child.emitLine(JSON.stringify({ id: 1, ok: false, code: "stale_observation", error: "observe again" }));
    await expect(pressing).rejects.toMatchObject({ code: "stale_observation" });
    await gateway.stop();
  });

  it("rejects pending requests when the helper exits", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const dispatching = gateway.dispatch({ op: "move", x: 1, y: 2 });
    child.kill();
    await expect(dispatching).rejects.toThrow("exited");
  });

  it("rejects start with the spawn error and reports the helper as not running", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/nonexistent/desktop-input", spawnImpl: () => child });
    const starting = gateway.start();
    child.emitError(Object.assign(new Error("spawn /nonexistent/desktop-input ENOENT"), { code: "ENOENT" }));
    await expect(starting).rejects.toThrow("ENOENT");
    await expect(gateway.checkAccessibility()).rejects.toThrow("not running");
  });

  it("surfaces helper stderr through the onError hook", async () => {
    const child = new FakeHelperProcess();
    const onStderr = vi.fn();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child, onStderr });
    await gateway.start();
    child.emitStderr("helper says hi\n");
    expect(onStderr).toHaveBeenCalledWith("helper says hi");
    await gateway.stop();
  });
});

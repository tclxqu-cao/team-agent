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

  it("reports accessibility trust from the check command", async () => {
    const child = new FakeHelperProcess();
    const gateway = new DesktopInputGateway({ helperPath: "/tmp/desktop-input", spawnImpl: () => child });
    await gateway.start();
    const checking = gateway.checkAccessibility();
    child.emitLine(JSON.stringify({ id: 1, ok: true, trusted: false }));
    await expect(checking).resolves.toBe(false);
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

import { describe, expect, it, vi } from "vitest";
import { forceStopCodexDesktop } from "./codex-desktop-force-stop.js";
const binary = "/Applications/Codex.app/Contents/MacOS/Codex";
const desktop = { pid: 10, parent: 1, started: "today", command: binary };
const backend = { pid: 20, parent: 10, started: "today", command: "/Applications/Codex.app/Contents/Resources/codex app-server --stdio" };
describe("scoped Desktop force stop", () => {
  it("kills only Desktop and its private backend, never the shared daemon or another client", () => {
    const kill = vi.fn();
    forceStopCodexDesktop(10, binary, { kill, snapshot: () => [desktop, backend,
      { ...backend, pid: 30, parent: 1 }, { ...backend, pid: 40, command: "/tools/codex app-server proxy" }] });
    expect(kill.mock.calls).toEqual([[20], [10]]);
  });
  it("refuses a replaced PID", () => {
    const kill = vi.fn(); let count = 0;
    expect(() => forceStopCodexDesktop(10, binary, { kill, snapshot: () => ++count === 1 ? [desktop] : [{ ...desktop, started: "later" }] })).toThrow("identity changed");
    expect(kill).not.toHaveBeenCalled();
  });
  it("refuses a different application", () => {
    const kill = vi.fn();
    expect(() => forceStopCodexDesktop(10, binary, { kill, snapshot: () => [{ ...desktop, command: "/other/app" }] })).toThrow("process changed");
    expect(kill).not.toHaveBeenCalled();
  });
});

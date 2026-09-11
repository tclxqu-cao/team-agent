import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wsServerSource = readFileSync(new URL("../ws-server.mjs", import.meta.url), "utf8");

describe("terminal readiness lifecycle contract", () => {
  it("uses managed shell launch instead of delayed PTY bootstrap input", () => {
    expect(wsServerSource).toContain("createTerminalShellLaunch({ shell, command, serverBaseDir");
    expect(wsServerSource).toContain("env: launch.env");
    expect(wsServerSource).not.toMatch(/setTimeout\([\s\S]{0,300}pty\.write/);
    expect(wsServerSource).not.toContain("const hook = `function __ca_hist_preexec");
    expect(wsServerSource).not.toContain("const integration=`function global:prompt");
  });

  it("marks readiness once and sends the initial command once", () => {
    expect(wsServerSource).toContain("if (session.ready) return");
    expect(wsServerSource).toContain("session.initialCommandSent = true");
    expect(wsServerSource).toContain("session.pty.write(`${session.initialCommand}\\r`)");
    expect(wsServerSource).toContain("if (!launch.waitsForReady) markTerminalReady(session)");
  });

  it("forwards readiness to attached clients and returns current state", () => {
    expect(wsServerSource).toContain('conn.sendJson({ type: "term:ready", id })');
    expect(wsServerSource).toContain("session.readyWatchers.add(readyForward)");
    expect(wsServerSource).toContain("session.readyWatchers.delete(readyFwd)");
    expect(wsServerSource).toContain("session.readyWatchers.clear()");
    expect(wsServerSource).toContain("ready: session.ready");
  });

  it("queues reset and scrollback after the start response can install its channel", () => {
    expect(wsServerSource).toMatch(/setImmediate\(\(\) => \{[\s\S]*conn\.sendTerminalReset\(id\);[\s\S]*session\.scrollback\.snapshot\(\)/);
  });

  it("marks replay frames explicitly for clients that support silent replay", () => {
    expect(wsServerSource).toContain("frame[1] = replay ? 6 : 2");
    expect(wsServerSource).toContain("conn.sendTerminal(id, new Uint8Array(snap), msg.replayFrames === true)");
    const gatewaySource = readFileSync(new URL("../app/web/useGateway.ts", import.meta.url), "utf8");
    const paneSource = readFileSync(new URL("../app/web/TerminalPane.tsx", import.meta.url), "utf8");
    expect(gatewaySource).toContain("handler(frame.subarray(6), frame[1] === 6)");
    expect(gatewaySource).not.toContain("frame[1] === 4");
    expect(paneSource).toContain("replayFrames: true");
    expect(paneSource).toContain("writer.current(bytes, replay)");
  });
});

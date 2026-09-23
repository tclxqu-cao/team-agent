// @ts-nocheck -- This test intentionally exercises the JavaScript smoke entrypoint as shipped.
import { describe, expect, it } from "vitest";
import { ComputerOperationError } from "../packages/computer-use/src/index.ts";
import { runComputerAgentLoop, runOwnershipProbe } from "./computer-use-smoke.mjs";

function accessibility(revision) {
  return {
    source: "accessibility",
    revision,
    coverage: "complete",
    app: { name: "Fixture", bundleId: "dev.agentroam.fixture", pid: 1 },
    nodes: [
      { id: `${revision}:field`, role: "AXTextField", identifier: "computer-fixture.text", actions: [] },
      { id: `${revision}:button`, role: "AXButton", identifier: "computer-fixture.press", actions: ["AXPress"] },
      {
        id: `${revision}:canvas`,
        role: "AXGroup",
        identifier: "computer-fixture.canvas",
        bounds: { x: 100, y: 200, width: 400, height: 200 },
        actions: [],
      },
    ],
  };
}

function successfulRuntime() {
  let revision = 0;
  let latest = null;
  const actions = [];
  return {
    actions,
    status: async () => ({ available: true, platform: "darwin", protocolVersion: 1, accessibility: true, screenRecording: true }),
    execute: async (action) => {
      actions.push(action);
      if (action.action === "press" && action.revision !== latest?.revision) {
        throw new ComputerOperationError("stale_observation", "stale");
      }
      if (action.action === "screenshot") {
        return {
          source: "screenshot",
          revision: "screen_1",
          coverage: "complete",
          reason: "explicit",
          image: {
            mimeType: "image/jpeg",
            dataUrl: "data:image/jpeg;base64,YWJj",
            width: 1000,
            height: 800,
            logicalWidth: 1000,
            logicalHeight: 800,
            originX: 0,
            originY: 0,
          },
        };
      }
      latest = accessibility(`ax_${++revision}`);
      return latest;
    },
  };
}

describe("computer-use runtime smoke", () => {
  it("drives the full single-action AgentLoop contract without approval or public observation leaks", async () => {
    const runtime = successfulRuntime();
    const result = await runComputerAgentLoop({
      registrationOptions: { probe: runtime, runtime },
    });

    expect(result.outcome, JSON.stringify(result)).toBe("passed");
    expect(result.approvals).toEqual([]);
    expect(result.publicPayloadLeaked).toBe(false);
    expect(result.state.toolPolicyVerified).toBe(true);
    expect(result.state.screenshotDelivered).toBe(true);
    expect(runtime.actions.map(({ action }) => action)).toEqual([
      "observe", "type", "press", "observe", "press", "screenshot", "click",
    ]);
    expect(runtime.actions.at(-1)).toMatchObject({ action: "click", x: 300, y: 300 });
  });

  it.each([
    ["screen_recording_denied", false],
    ["desktop_locked", true],
  ])("reports the %s runtime limit instead of claiming success", async (errorCode, desktopLocked) => {
    const runtime = {
      status: async () => ({
        available: true,
        platform: "darwin",
        protocolVersion: 1,
        desktopLocked,
        accessibility: false,
        screenRecording: false,
      }),
      execute: async () => { throw new ComputerOperationError(errorCode, "runtime unavailable"); },
    };
    const result = await runComputerAgentLoop({ registrationOptions: { probe: runtime, runtime } });
    expect(result.outcome, JSON.stringify(result)).toBe("limited");
    expect(result.limitation).toMatchObject({ error: errorCode });
    expect(result.approvals).toEqual([]);
  });

  it("allows observation but blocks mutation through the real ownership guard and relay", async () => {
    await expect(runOwnershipProbe()).resolves.toEqual({
      passed: true,
      observationSource: "accessibility",
      mutationError: "desktop_controlled_by_user",
      inputCalls: 0,
    });
  });
});

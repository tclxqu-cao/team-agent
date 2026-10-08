import { describe, expect, it } from "vitest";
import {
  RemoteVideoStallPolicy,
  REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS,
  REMOTE_VIDEO_STALL_TIMEOUT_MS,
} from "./remote-video-stall";

describe("RemoteVideoStallPolicy", () => {
  it("streams once the first frame arrives and stays streaming while frames advance", () => {
    const policy = new RemoteVideoStallPolicy();
    policy.begin(0);
    expect(policy.evaluate(REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS - 1).state).toBe("streaming");
    policy.observe(10, 1_000);
    expect(policy.evaluate(REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS).state).toBe("streaming");
    policy.observe(25, 2_000);
    expect(policy.evaluate(2_000 + REMOTE_VIDEO_STALL_TIMEOUT_MS - 1).state).toBe("streaming");
  });

  it("stalls when the first frame never arrives within the first-frame timeout", () => {
    const policy = new RemoteVideoStallPolicy();
    policy.begin(100);
    const decision = policy.evaluate(100 + REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS);
    expect(decision.state).toBe("stalled");
    expect(decision.silentForMs).toBe(REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS);
  });

  it("stalls when frames stop arriving for the steady-stream timeout", () => {
    const policy = new RemoteVideoStallPolicy();
    policy.begin(0);
    policy.observe(100, 4_000);
    expect(policy.evaluate(4_000 + REMOTE_VIDEO_STALL_TIMEOUT_MS - 1).state).toBe("streaming");
    expect(policy.evaluate(4_000 + REMOTE_VIDEO_STALL_TIMEOUT_MS).state).toBe("stalled");
  });

  it("treats a counter reset (renegotiation) as fresh activity", () => {
    const policy = new RemoteVideoStallPolicy();
    policy.begin(0);
    policy.observe(500, 1_000);
    policy.observe(0, 6_000);
    expect(policy.evaluate(6_000 + REMOTE_VIDEO_STALL_TIMEOUT_MS - 1).state).toBe("streaming");
  });

  it("ignores undefined or non-finite counters", () => {
    const policy = new RemoteVideoStallPolicy();
    policy.begin(0);
    policy.observe(undefined, 1_000);
    expect(policy.evaluate(REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS).state).toBe("stalled");
    policy.observe(Number.NaN, 2_000);
    expect(policy.evaluate(REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS + 1).silentForMs).toBe(REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS + 1);
  });

  it("streams without any baseline before begin()", () => {
    const policy = new RemoteVideoStallPolicy();
    expect(policy.evaluate(Date.now())).toEqual({ state: "streaming", silentForMs: 0 });
  });

  it("measures from begin() again after a renegotiation", () => {
    const policy = new RemoteVideoStallPolicy();
    policy.begin(0);
    policy.observe(10, 1_000);
    policy.begin(20_000);
    expect(policy.evaluate(20_000 + REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS - 1).state).toBe("streaming");
    expect(policy.evaluate(20_000 + REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS).state).toBe("stalled");
  });
});

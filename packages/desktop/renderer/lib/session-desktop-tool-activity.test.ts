import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../stores/agentStore";
import { sessionDesktopStatus } from "../components/SessionDesktopProjection";
import { updateSessionDesktopToolActivity } from "./session-desktop-tool-activity";

const cuaCall = {
  type: "tool_call",
  _nativeRunId: "cua-run",
  toolCall: { id: "tool-call", name: "cua_repl:js", arguments: { code: 'await cua.getApp("Example")' } },
} satisfies StreamEvent;

describe("session desktop projection activity", () => {
  it("selects the native run that called CUA even when the desktop lease is empty", () => {
    const activity = updateSessionDesktopToolActivity(new Map(), "codex-session", cuaCall);
    expect(sessionDesktopStatus({ owner: null, queue: [] }, "codex-session", activity.get("codex-session")))
      .toEqual({ runId: "cua-run", status: "本会话调用了电脑工具" });
    expect(sessionDesktopStatus({ owner: null, queue: [] }, "other-session", activity.get("other-session")))
      .toEqual({ runId: null, status: "共享桌面" });
  });

  it("ignores shell activity and CUA completion summaries", () => {
    const activity = new Map();
    expect(updateSessionDesktopToolActivity(activity, "codex-session", {
      ...cuaCall, toolCall: { ...cuaCall.toolCall, name: "shell" },
    })).toBe(activity);
    expect(updateSessionDesktopToolActivity(activity, "codex-session", {
      ...cuaCall, toolCall: { ...cuaCall.toolCall, arguments: { completion_summary: "Checked the window" } },
    })).toBe(activity);
  });

  it("keeps projection through the tool result and clears it on the matching terminal event", () => {
    const activity = updateSessionDesktopToolActivity(new Map(), "codex-session", cuaCall);
    expect(updateSessionDesktopToolActivity(activity, "codex-session", { type: "tool_result", _nativeRunId: "cua-run" })).toBe(activity);
    expect(updateSessionDesktopToolActivity(activity, "codex-session", { type: "done", _nativeRunId: "older-run" })).toBe(activity);
    const completed = updateSessionDesktopToolActivity(activity, "codex-session", { type: "done", _nativeRunId: "cua-run" });
    expect(completed.has("codex-session")).toBe(false);
  });
});

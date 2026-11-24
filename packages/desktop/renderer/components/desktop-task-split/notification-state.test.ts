import { describe, expect, it } from "vitest";
import type { UnifiedSessionSummary } from "../../../../shared/src/contracts/agent-api";
import { equalTaskLayout } from "../../lib/desktop-task-layout";
import { closeTaskWorkspacePane, pushTaskPaneNotification, readTaskWorkspace, serializeTaskWorkspace,
  updateTaskPaneContent, updateTaskPaneDraft, updateTaskPaneSession, type TaskPane, type TaskWorkspaceSnapshot } from "./session-state";

const session = (id: string): UnifiedSessionSummary => ({
  id, agentType: "codex", nativeSessionId: id, title: id, cwd: `/project/${id}`,
  created: "2026-11-18", updated: "2026-11-18", status: "idle", occupancy: "available",
  sourceLabel: "Codex", canResume: true, canDelete: false,
});
const original = session("original");
const notification = session("notification");
const seed = { sessionId: original.id, detail: { ...original, messages: [] } };

function workspace(content: Omit<TaskPane, "id"> = { session: original, initialHistory: seed }): TaskWorkspaceSnapshot {
  const layout = equalTaskLayout(["left", "right"])!;
  return { panes: [{ id: "left", ...content }, { id: "right", session: session("other-pane") }],
    layout: layout.kind === "split" ? { ...layout, ratio: .63 } : layout, activePaneId: "right" };
}

describe("temporary notifications inside a selected task pane", () => {
  it("restores the prior session and its history when the notification is closed", () => {
    const initial = workspace();
    const noticeSeed = { sessionId: notification.id, detail: { ...notification, messages: [] } };
    const opened = pushTaskPaneNotification(initial, "left", notification, noticeSeed);
    expect(opened.layout).toBe(initial.layout);
    expect(opened.activePaneId).toBe(initial.activePaneId);
    expect(opened.panes[1]).toBe(initial.panes[1]);
    expect(opened.panes[0].session).toBe(notification);
    expect(opened.panes[0].initialHistory).toBe(noticeSeed);
    expect(opened.panes[0].history).toEqual([{ session: original, initialHistory: seed }]);
    expect(opened.panes[0].temporary).toBe(true);
    const restored = closeTaskWorkspacePane(opened, "left")!;
    expect(restored.panes[0]).toEqual(initial.panes[0]);
    expect(restored.panes[0].initialHistory).toBe(seed);
    expect(restored.panes[1]).toBe(initial.panes[1]);
    expect(restored.layout).toBe(initial.layout);
    expect(restored.activePaneId).toBe("right");
    expect(closeTaskWorkspacePane(restored, "left")?.panes).toEqual([initial.panes[1]]);
  });

  it("restores consecutive notifications one layer at a time without nesting stacks", () => {
    const initial = workspace();
    const first = pushTaskPaneNotification(initial, "left", notification);
    const second = pushTaskPaneNotification(first, "left", session("second-notification"));
    expect(second.panes[0].history).toHaveLength(2);
    expect(second.panes[0].history?.every(item => !("history" in item) && !("id" in item))).toBe(true);
    const back = closeTaskWorkspacePane(second, "left")!;
    expect(back.panes[0]).toEqual(first.panes[0]);
    expect(back.panes[0].temporary).toBe(true);
    expect(closeTaskWorkspacePane(back, "left")?.panes[0]).toEqual(initial.panes[0]);
  });

  it("does not stack repeated clicks on the current notification", () => {
    const initial = workspace();
    const opened = pushTaskPaneNotification(initial, "left", notification);
    expect(pushTaskPaneNotification(opened, "left", { ...notification, title: "same target" })).toBe(opened);
    expect(pushTaskPaneNotification(initial, "left", original)).toBe(initial);
    expect(opened.panes[0].history).toHaveLength(1);
  });

  it.each([
    { session: null, draft: { agentType: "claude-code" as const, projectId: "draft-project", cwd: "/draft", workspaceSource: "imported" as const } },
    { session: null, surface: "calendar" as const },
    { session: null, webUrl: "https://example.com/working-page" },
  ])("restores the previous non-session content: %j", content => {
    const initial = workspace(content);
    const opened = pushTaskPaneNotification(initial, "left", notification);
    expect(opened.panes[0].draft).toBeUndefined();
    expect(opened.panes[0].surface).toBeUndefined();
    expect(opened.panes[0].webUrl).toBeUndefined();
    expect(closeTaskWorkspacePane(opened, "left")?.panes[0]).toEqual(initial.panes[0]);
    expect(serializeTaskWorkspace(opened)).toBe(serializeTaskWorkspace(initial));
    expect(readTaskWorkspace(JSON.parse(serializeTaskWorkspace(opened)))?.panes[0]).toEqual(initial.panes[0]);
  });

  it("does not keep an empty placeholder beneath a notification and removes the slot on close", () => {
    const initial = workspace({ session: null });
    const opened = pushTaskPaneNotification(initial, "left", notification);
    expect(opened.panes[0].history).toBeUndefined();
    expect(opened.panes[0].temporary).toBe(true);
    const closed = closeTaskWorkspacePane(opened, "left")!;
    expect(closed.panes).toEqual([initial.panes[1]]);
    expect(closed.layout).toEqual({ kind: "pane", paneId: "right" });
    expect(closed.activePaneId).toBe("right");
    expect(serializeTaskWorkspace(opened)).toBe(serializeTaskWorkspace(initial));
    const single = { ...opened, panes: [opened.panes[0]], layout: { kind: "pane" as const, paneId: "left" }, activePaneId: "left" };
    expect(closeTaskWorkspacePane(single, "left")).toBeNull();
  });

  it("covers the clicked pane even when the same notification session is already in another pane", () => {
    const initial = workspace();
    initial.panes[1] = { id: "right", session: notification };
    const opened = pushTaskPaneNotification(initial, "left", notification);
    expect(opened.panes[0].session?.id).toBe(notification.id);
    expect(opened.panes[1]).toBe(initial.panes[1]);
    expect(opened.panes).toHaveLength(2);
    const restored = readTaskWorkspace(JSON.parse(serializeTaskWorkspace(opened)))!;
    expect(restored.panes[0].session?.id).toBe(original.id);
    expect(restored.panes[1].session?.id).toBe(notification.id);
  });

  it("does not revive a pane that was removed before the notification load completed", () => {
    const initial = workspace();
    const removed = { ...initial, panes: [initial.panes[1]], layout: { kind: "pane" as const, paneId: "right" } };
    expect(pushTaskPaneNotification(removed, "left", notification)).toBe(removed);
    expect(closeTaskWorkspacePane(removed, "left")).toBe(removed);
  });

  it("shares one LIFO history across notifications, manual sessions, features and drafts", () => {
    const initial = workspace();
    const opened = pushTaskPaneNotification(initial, "left", notification);
    const replacement = updateTaskPaneSession(opened, "left", session("manual-replacement"));
    const surface = updateTaskPaneContent(replacement, "left", { surface: "dashboard" });
    const draft = updateTaskPaneDraft(surface, "left", { agentType: "codex", projectId: null, cwd: "/manual-draft" });
    let current = draft;
    for (const expected of [surface, replacement, opened, initial]) {
      current = closeTaskWorkspacePane(current, "left")!;
      expect(current.panes[0]).toEqual(expected.panes[0]);
      expect(current.layout).toBe(initial.layout);
      expect(current.activePaneId).toBe("right");
      expect(current.panes[1]).toBe(initial.panes[1]);
    }
    expect(closeTaskWorkspacePane(current, "left")?.panes).toEqual([initial.panes[1]]);
  });

  it("clears all history only when the user explicitly clears the pane", () => {
    const opened = pushTaskPaneNotification(workspace(), "left", notification);
    const cleared = updateTaskPaneContent(opened, "left", null);
    expect(cleared.panes[0]).toEqual({ id: "left", session: null });
    const draft = updateTaskPaneDraft(cleared, "left", { agentType: "codex", projectId: null, cwd: "/manual-draft" });
    expect(draft.panes[0].history).toBeUndefined();
    expect(draft.panes[0].temporary).toBeUndefined();
    expect(closeTaskWorkspacePane(draft, "left")?.panes).toEqual([opened.panes[1]]);
  });

  it("persists only the original workspace beneath all temporary layers", () => {
    const initial = workspace();
    const opened = pushTaskPaneNotification(pushTaskPaneNotification(initial, "left", notification), "left", session("second-notification"));
    const serialized = serializeTaskWorkspace(opened);
    expect(serialized).not.toContain("notification");
    expect(serialized).not.toContain("initialHistory");
    expect(serialized).toBe(serializeTaskWorkspace(initial));
    const restored = readTaskWorkspace(JSON.parse(serialized))!;
    expect(restored.panes[0].session?.id).toBe(original.id);
    expect(restored.panes[0].history).toBeUndefined();
    expect(restored.panes[0].temporary).toBeUndefined();
    expect(restored.layout).toEqual(initial.layout);
  });

  it("persists manual navigation beneath later notifications while omitting every temporary layer", () => {
    const initial = workspace();
    const notice = pushTaskPaneNotification(initial, "left", notification);
    const manual = updateTaskPaneSession(notice, "left", session("manual-session"));
    const opened = pushTaskPaneNotification(manual, "left", session("second-notification"));
    const serialized = serializeTaskWorkspace(opened);
    expect(serialized).not.toContain("notification");
    expect(serialized).not.toContain("temporary");
    expect(serialized).not.toContain("initialHistory");
    const restored = readTaskWorkspace(JSON.parse(serialized))!;
    expect(restored.panes[0].session?.id).toBe("manual-session");
    expect(restored.panes[0].history?.map(item => item.session?.id)).toEqual([original.id]);
    const back = closeTaskWorkspacePane(restored, "left")!;
    expect(back.panes[0].session?.id).toBe(original.id);
    expect(back.layout).toEqual(initial.layout);
    expect(back.activePaneId).toBe("right");
    expect(closeTaskWorkspacePane(back, "left")?.panes.map(pane => pane.id)).toEqual(["right"]);
  });
});

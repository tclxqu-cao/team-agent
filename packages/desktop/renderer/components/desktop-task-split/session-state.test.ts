import { describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "../../global";
import { equalTaskLayout, resizeTaskSplit, taskSplitGeometry } from "../../lib/desktop-task-layout";
import { addTaskWorkspaceColumn, addTaskWorkspaceSession, fourColumnTaskWorkspace, loadTaskSession, openTaskWorkspaceWebPage, readTaskWorkspace, serializeTaskWorkspace, taskPaneHistorySeed, updateTaskPaneContent, updateTaskPaneDraft, updateTaskPaneSession } from "./session-state";

const session: UnifiedSessionSummary = {
  id: "runtime:codex:first", agentType: "codex", nativeSessionId: "first", title: "first task", cwd: "/project",
  created: "2026-11-17", updated: "2026-11-17", status: "running", occupancy: "available",
  sourceLabel: "Codex", canResume: true, canDelete: false,
};

describe("desktop workspace persistence and session hydration", () => {
  it("restores feature and web panes, preserving their geometry and keeping them occupied when tasks are added", () => {
    const initial = { panes: [{ id: "a", session }, { id: "b", session: null }, { id: "c", session: null }], layout: equalTaskLayout(["a", "b", "c"])!, activePaneId: "a" };
    const features = updateTaskPaneContent(updateTaskPaneContent(initial, "b", { surface: "calendar" }), "c", { webUrl: "https://example.com/path" });
    const restored = readTaskWorkspace(JSON.parse(serializeTaskWorkspace(features)))!;
    expect(restored.panes[1].surface).toBe("calendar");
    expect(restored.panes[2].webUrl).toBe("https://example.com/path");
    expect(restored.layout).toEqual(features.layout);
    const added = addTaskWorkspaceSession(features, { ...session, id: "new-task" }, "d");
    expect(added.paneId).toBe("d");
    expect(added.state.panes.slice(0, 3)).toEqual(features.panes);
    expect(updateTaskPaneSession(features, "b", session).panes[1].surface).toBeUndefined();
    expect(updateTaskPaneDraft(features, "c", { agentType: "codex", cwd: "/draft", projectId: null }).panes[2].webUrl).toBeUndefined();
  });

  it("opens links in the focused empty pane, then other empty slots without replacing chosen contents", () => {
    const initial = { panes: [{ id: "a", session }, { id: "b", session: null }, { id: "c", session: null }], layout: equalTaskLayout(["a", "b", "c"])!, activePaneId: "c" };
    const opened = openTaskWorkspaceWebPage(initial, "https://example.com/first")!;
    expect(opened.activePaneId).toBe("c");
    expect(opened.panes[2].webUrl).toBe("https://example.com/first");
    expect(opened.layout).toBe(initial.layout);
    const second = openTaskWorkspaceWebPage(opened, "https://example.com/second")!;
    expect(second.panes[1].webUrl).toBe("https://example.com/second");
    expect(second.panes[0]).toBe(initial.panes[0]);
    expect(second.panes[2]).toBe(opened.panes[2]);
    expect(openTaskWorkspaceWebPage(second, "https://example.com/third")).toBeNull();
    expect(openTaskWorkspaceWebPage(initial, "javascript:alert(1)")).toBeNull();
    expect(openTaskWorkspaceWebPage(initial, "file:///private/file")).toBeNull();
  });

  it("only clears the selected pane and rejects unknown or conflicting saved content", () => {
    const initial = { panes: [{ id: "a", session }, { id: "b", session: null }], layout: equalTaskLayout(["a", "b"])!, activePaneId: "a" };
    const changed = updateTaskPaneContent(initial, "a", { surface: "dashboard" });
    expect(changed.panes[0]).toEqual({ id: "a", session: null, surface: "dashboard" });
    expect(changed.panes[1]).toBe(initial.panes[1]);
    expect(updateTaskPaneContent(changed, "a", null).panes[0]).toEqual({ id: "a", session: null });
    for (const content of [{ surface: "unknown" }, { webUrl: "data:text/html,test" }, { surface: "groups", webUrl: "https://example.com" }]) {
      const saved = JSON.parse(serializeTaskWorkspace(changed));
      saved.panes[0] = { id: "a", session: null, ...content };
      expect(readTaskWorkspace(saved)).toBeNull();
    }
  });

  it("adds a full-height fifth column while retaining custom proportions and restoring the new mode", () => {
    let next = 0;
    const four = fourColumnTaskWorkspace({ panes: [{ id: "a", session }], layout: { kind: "pane", paneId: "a" }, activePaneId: "a" }, () => `empty-${++next}`);
    const layout = resizeTaskSplit(four.layout, four.layout.kind === "split" ? four.layout.id : "", .67);
    const added = addTaskWorkspaceColumn({ ...four, layout }, "fifth");
    expect(added.layout.kind === "split" && added.layout.first).toBe(layout);
    const geometry = taskSplitGeometry(added.layout, 1500, 700);
    expect(new Set(geometry.panes.map(pane => pane.rect.x)).size).toBe(5);
    expect(geometry.panes.every(pane => pane.rect.height === 700)).toBe(true);
    expect(added.panes.slice(0, 4)).toEqual(four.panes);
    expect(added.activePaneId).toBe("fifth");
    expect(readTaskWorkspace(JSON.parse(serializeTaskWorkspace(added)))?.layoutMode).toBe("columns");
  });

  it("keeps a new-session composer in its own slot and does not overwrite it when adding a task", () => {
    const layout = equalTaskLayout(["a", "b", "c"])!;
    const initial = { panes: [{ id: "a", session }, { id: "b", session: null }, { id: "c", session: null }], layout, activePaneId: "b" };
    const draft = { agentType: "claude-code" as const, projectId: "imported", cwd: "/draft-project", workspaceSource: "imported" as const };
    const started = updateTaskPaneDraft(initial, "b", draft);
    expect(started.layout).toBe(layout);
    expect(started.panes[0]).toBe(initial.panes[0]);
    expect(started.panes[1].draft).toBe(draft);
    const added = addTaskWorkspaceSession(started, { ...session, id: "second" }, "unused");
    expect(added.paneId).toBe("c");
    expect(added.state.panes[1].draft).toBe(draft);
    const restored = readTaskWorkspace(JSON.parse(serializeTaskWorkspace(started)));
    expect(restored?.panes[1].draft).toEqual(draft);
    const created = updateTaskPaneSession(started, "b", { ...session, id: "created" });
    expect(created.layout).toBe(layout);
    expect(created.panes[1].draft).toBeUndefined();
    expect(created.panes[1].session?.id).toBe("created");
    expect(updateTaskPaneDraft(created, "b", draft)).toBe(created);
    const invalid = JSON.parse(serializeTaskWorkspace(started));
    invalid.panes[1].draft.agentType = "unknown-agent";
    expect(readTaskWorkspace(invalid)).toBeNull();
  });

  it("forwards the exact sidebar history seed so the global loading controller can settle", () => {
    const original = { sessionId: session.id, detail: { id: session.id } };
    const navigation = { sessionId: session.id, detail: { id: session.id, messages: [] } };
    const pane = { id: "pane", session, initialHistory: original };
    expect(taskPaneHistorySeed(pane, navigation)).toBe(navigation);
    expect(taskPaneHistorySeed(pane, { sessionId: "other", detail: {} })).toBe(original);
    expect(taskPaneHistorySeed({ ...pane, initialHistory: undefined }, navigation)).toBe(navigation);
  });

  it("creates four columns and fills an empty slot without touching a dragged divider", () => {
    let next = 0;
    const four = fourColumnTaskWorkspace({ panes: [{ id: "a", session }], layout: { kind: "pane", paneId: "a" }, activePaneId: "a" }, () => `empty-${++next}`);
    expect(four.panes).toHaveLength(4);
    expect(four.panes[0].session).toBe(session);
    expect(taskSplitGeometry(four.layout, 1103, 600).panes.map(pane => pane.rect.width)).toEqual([275, 275, 275, 275]);
    const layout = resizeTaskSplit(four.layout, four.layout.kind === "split" ? four.layout.id : "", .67);
    const added = addTaskWorkspaceSession({ ...four, layout }, { ...session, id: "second" }, "unused-new-slot");
    expect(added.state.layout).toBe(layout);
    expect(added.state.panes).toHaveLength(4);
    expect(added.paneId).toBe("empty-1");
    expect(readTaskWorkspace(JSON.parse(serializeTaskWorkspace(added.state)))?.layoutMode).toBe("four-columns");
  });

  it("keeps custom column ratios and adds a local slot instead of rebuilding a grid", () => {
    const initial = equalTaskLayout(["a", "b"])!;
    if (initial.kind !== "split") throw new Error("Expected split");
    const layout = { ...initial, ratio: .73 };
    const added = addTaskWorkspaceSession({ panes: [{ id: "a", session }, { id: "b", session: { ...session, id: "second" } }], layout, activePaneId: "a" }, { ...session, id: "third" }, "c").state;
    expect(added.layout.kind === "split" && added.layout.ratio).toBe(.73);
    expect(added.layout.kind === "split" && added.layout.second).toBe(layout.second);
    expect(taskSplitGeometry(added.layout, 1000, 600).panes.every(pane => pane.rect.height === 600)).toBe(true);
  });

  it("keeps four columns when a fifth task needs a new slot", () => {
    const panes = ["a", "b", "c", "d"].map(id => ({ id, session: { ...session, id } }));
    const four = fourColumnTaskWorkspace({ panes, layout: equalTaskLayout(panes.map(pane => pane.id))!, activePaneId: "d" }, () => "unused");
    const added = addTaskWorkspaceSession(four, { ...session, id: "fifth" }, "e").state;
    const geometry = taskSplitGeometry(added.layout, 1103, 600);
    expect(new Set(geometry.panes.map(pane => pane.rect.x)).size).toBe(4);
    expect(geometry.panes).toHaveLength(5);
    expect(added.layout.kind === "split" && added.layout.ratio).toBe(four.layout.kind === "split" && four.layout.ratio);
  });

  it("does not steal another pane's focus when a replacement finishes after navigation", () => {
    const layout = equalTaskLayout(["left", "right"])!;
    const original = { panes: [{ id: "left", session }, { id: "right", session: null }], layout, activePaneId: "left" };
    const result = updateTaskPaneSession(original, "right", { ...session, id: "other-task", title: "replacement" });
    expect(result.activePaneId).toBe("left");
    expect(result.layout).toBe(layout);
    expect(result.panes[0]).toBe(original.panes[0]);
    expect(result.panes[1].session?.id).toBe("other-task");
    expect(updateTaskPaneSession(original, "closed-pane", session)).toBe(original);
  });
  it("restores selected tasks and custom proportions without persisting transcript contents", () => {
    const initial = { sessionId: session.id, detail: { ...session, messages: [{ role: "user", content: "private transcript" }] } };
    const layout = equalTaskLayout(["a", "b"])!;
    if (layout.kind !== "split") throw new Error("Expected split");
    const serialized = serializeTaskWorkspace({ panes: [{ id: "a", session, initialHistory: initial }, { id: "b", session: null }], layout: { ...layout, ratio: 0.7 }, activePaneId: "b" });
    expect(serialized).not.toContain("private transcript");
    expect(serialized).not.toContain("initialHistory");
    const restored = readTaskWorkspace(JSON.parse(serialized));
    expect(restored?.activePaneId).toBe("b");
    expect(restored?.layout.kind === "split" && restored.layout.ratio).toBe(0.7);
    expect(restored?.panes[0].session?.id).toBe(session.id);
    expect(restored?.panes[1].session).toBeNull();
    expect(readTaskWorkspace({ version: 1, panes: [{ id: "a", session }, { id: "b", session }], layout })).toBeNull();
    expect(readTaskWorkspace({ ...JSON.parse(serialized), version: 2 })).toBeNull();
  });

  it("hydrates exactly the requested Codex identity with bounded core history", async () => {
    const getSession = vi.fn().mockResolvedValue({ ...session, messages: [], events: [] });
    vi.stubGlobal("window", { agentApi: { getSession } });
    try {
      const result = await loadTaskSession(session);
      expect(getSession).toHaveBeenCalledWith(session.id, { view: "core", limit: 1 });
      expect(result.session?.id).toBe(session.id);
      expect(result.session).not.toHaveProperty("messages");
      expect(result.initialHistory?.sessionId).toBe(session.id);
      getSession.mockResolvedValue({ ...session, id: "wrong-session" });
      await expect(loadTaskSession(session)).rejects.toThrow("会话身份已变化");
    } finally { vi.unstubAllGlobals(); }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { requestTaskPaneNotification, TASK_PANE_NOTIFICATION_EVENT, type TaskPaneNotificationRequest } from "./task-pane-notification";

afterEach(() => vi.unstubAllGlobals());

describe("notification navigation handoff", () => {
  it("leaves ordinary notification navigation unchanged without an open split workspace", () => {
    vi.stubGlobal("window", new EventTarget());
    expect(requestTaskPaneNotification("runtime:codex:notice")).toBe(false);
  });

  it("lets a split workspace claim the exact session before ordinary navigation starts", () => {
    const host = new EventTarget();
    vi.stubGlobal("window", host);
    const accepted = vi.fn();
    host.addEventListener(TASK_PANE_NOTIFICATION_EVENT, event => {
      accepted((event as CustomEvent<TaskPaneNotificationRequest>).detail.sessionId);
      event.preventDefault();
    });
    expect(requestTaskPaneNotification("runtime:codex:notice")).toBe(true);
    expect(accepted).toHaveBeenCalledWith("runtime:codex:notice");
  });
});

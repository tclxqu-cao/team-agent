import { describe, expect, it } from "vitest";
import {
  EMPTY_SIDEBAR_SELECTION,
  parseSidebarSelection,
  selectProject,
  selectSession,
  serializeSidebarSelection,
} from "./sidebar-selection";

describe("sidebar selection", () => {
  it("selects a project as the active workspace context", () => {
    expect(selectProject(" project-a "))
      .toEqual({ projectId: "project-a", sessionId: null });
  });

  it("keeps repeated session selection idempotent", () => {
    expect(selectSession("project-a", "session-a"))
      .toEqual({ projectId: "project-a", sessionId: "session-a" });
    expect(selectSession("project-a", "session-a"))
      .toEqual({ projectId: "project-a", sessionId: "session-a" });
  });

  it("normalizes ids when selecting a session", () => {
    expect(selectSession(" project-a ", " session-a "))
      .toEqual({ projectId: "project-a", sessionId: "session-a" });
  });

  it("restores a persisted project session", () => {
    const raw = serializeSidebarSelection({ projectId: "project-a", sessionId: "session-a" });
    expect(parseSidebarSelection(raw)).toEqual({ projectId: "project-a", sessionId: "session-a" });
  });

  it("restores a session that has no registered project", () => {
    expect(parseSidebarSelection('{"projectId":null,"sessionId":"session-a"}'))
      .toEqual({ projectId: null, sessionId: "session-a" });
  });

  it("rejects malformed or sessionless persisted values", () => {
    expect(parseSidebarSelection("not-json")).toEqual(EMPTY_SIDEBAR_SELECTION);
    expect(parseSidebarSelection('{"projectId":"project-a","sessionId":" "}'))
      .toEqual(EMPTY_SIDEBAR_SELECTION);
    expect(serializeSidebarSelection({ projectId: "project-a", sessionId: null })).toBeNull();
  });
});

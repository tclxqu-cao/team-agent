import { expect, it } from "vitest";
import { readSessionDashboardIntent, SESSION_DASHBOARD_NAVIGATE } from "./SessionDashboardBridge.js";

it("accepts bounded session/group navigation only from the current trusted frame and origin", () => {
  const source = {} as Window;
  const event = { source, origin: "http://localhost", data: { type: SESSION_DASHBOARD_NAVIGATE, intent: { kind: "session", session: { id: "codex:target", agentType: "codex", title: "接口任务", cwd: "/project" } } } };
  expect(readSessionDashboardIntent(event, event.origin, source)?.kind).toBe("session");
  expect(readSessionDashboardIntent({ ...event, source: {} as Window }, event.origin, source)).toBeNull();
  expect(readSessionDashboardIntent({ ...event, origin: "https://other" }, event.origin, source)).toBeNull();
  expect(readSessionDashboardIntent({ ...event, data: { ...event.data, intent: { kind: "group", groupId: "../../evil", title: "群" } } }, event.origin, source)).toBeNull();
  expect(readSessionDashboardIntent({ ...event, data: { ...event.data, intent: { kind: "agent", agentType: "unknown" } } }, event.origin, source)).toBeNull();
});

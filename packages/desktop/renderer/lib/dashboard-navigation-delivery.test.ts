import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SESSION_DASHBOARD_APPLIED,
  SESSION_DASHBOARD_CHAT_READY,
  SESSION_DASHBOARD_NAVIGATE,
  type SessionDashboardIntent,
} from "../../../core/src/domain/web-console/SessionDashboardBridge";
import { postDashboardIntent } from "./dashboard-navigation-delivery";

const target = { kind: "session", session: { id: "codex:target", agentType: "codex", title: "任务", cwd: "/project" } } satisfies SessionDashboardIntent;
const origin = "http://localhost";
const chat = {} as Window;
let listeners: Set<(event: MessageEvent) => void>;
let pageHide: (() => void) | undefined;
let parent: { frames: Window[]; postMessage: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

function receive(data: unknown, source = chat, messageOrigin = origin) {
  for (const listener of [...listeners]) listener({ data, source, origin: messageOrigin } as MessageEvent);
}
function ready(instanceId = "chat-1") { receive({ type: SESSION_DASHBOARD_CHAT_READY, instanceId }); }

beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Set();
  pageHide = undefined;
  parent = {
    frames: [chat],
    postMessage: vi.fn(),
    addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)),
  };
  vi.stubGlobal("window", {
    parent, location: { origin }, dispatchEvent: vi.fn(),
    addEventListener: vi.fn((_type, listener) => { pageHide = listener; }),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { body: { dataset: {} } });
});
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("replays a click lost during chat reload, then stops after the exact selection is applied", () => {
  postDashboardIntent(target);
  expect(parent.postMessage).toHaveBeenCalledWith({ type: SESSION_DASHBOARD_NAVIGATE, intent: target }, origin);
  ready();
  expect(parent.postMessage).toHaveBeenCalledTimes(2);
  receive({ type: SESSION_DASHBOARD_APPLIED, sessionId: target.session.id });
  ready("later-reload");
  expect(parent.postMessage).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
});

it("does not reopen a successful normal navigation on a later chat reload", () => {
  postDashboardIntent(target);
  receive({ type: SESSION_DASHBOARD_APPLIED, sessionId: target.session.id });
  ready();
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
});

it("retains only the latest click and ignores an older selection acknowledgement", () => {
  const newer = { ...target, session: { ...target.session, id: "codex:newer" } };
  postDashboardIntent(target);
  postDashboardIntent(newer);
  receive({ type: SESSION_DASHBOARD_APPLIED, sessionId: target.session.id });
  ready();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: SESSION_DASHBOARD_NAVIGATE, intent: newer }, origin);
  receive({ type: SESSION_DASHBOARD_APPLIED, sessionId: newer.session.id });
  expect(listeners.size).toBe(0);
});

it("ignores foreign origins and windows outside the shell's sibling frames", () => {
  postDashboardIntent(target);
  receive({ type: SESSION_DASHBOARD_APPLIED, sessionId: target.session.id }, chat, "https://other");
  receive({ type: SESSION_DASHBOARD_CHAT_READY, instanceId: "untrusted" }, {} as Window);
  receive({ type: SESSION_DASHBOARD_APPLIED, sessionId: target.session.id }, {} as Window);
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
  ready();
  expect(parent.postMessage).toHaveBeenCalledTimes(2);
});

it("deduplicates readiness from the same mount but recovers another reload before acknowledgement", () => {
  postDashboardIntent(target);
  ready(); ready(); ready("chat-2");
  expect(parent.postMessage).toHaveBeenCalledTimes(3);
});

it("cancels pending replay when the user chooses a different destination", () => {
  postDashboardIntent(target);
  postDashboardIntent({ kind: "groups" });
  ready();
  expect(parent.postMessage).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
});

it("expires a pending click instead of reopening it much later", () => {
  postDashboardIntent(target);
  vi.advanceTimersByTime(30_000);
  ready();
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

it("removes pending delivery when its Dashboard document goes away", () => {
  postDashboardIntent(target);
  pageHide?.();
  ready();
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

it("keeps inline desktop Dashboard navigation local", () => {
  document.body.dataset.agentroamChatNavigation = "ready";
  postDashboardIntent(target);
  expect(window.dispatchEvent).toHaveBeenCalled();
  expect(parent.postMessage).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

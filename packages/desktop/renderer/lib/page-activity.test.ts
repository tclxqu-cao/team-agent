import { describe, expect, it, vi } from "vitest";
import { PAGE_ACTIVITY, PAGE_ACTIVITY_REQUEST } from "../../../core/src/domain/web-console/PageActivityBridge";
import { createPageActivity } from "./page-activity";

function fixture(embedded = true) {
  const host = new EventTarget() as EventTarget & Record<string, any>;
  const document = new EventTarget() as EventTarget & { visibilityState: string };
  document.visibilityState = "visible";
  const parent = { postMessage: vi.fn() };
  Object.assign(host, { document, location: { origin: "http://localhost:3000" }, parent: embedded ? parent : host });
  const state = createPageActivity(host as unknown as Window);
  const send = (active: unknown, origin = host.location.origin, source: unknown = host.parent) => {
    const event = new Event("message");
    Object.assign(event, { data: { type: PAGE_ACTIVITY, active }, origin, source });
    host.dispatchEvent(event);
  };
  return { host, document, parent, state, send };
}

describe("Shell page activity", () => {
  it("waits for the parent handshake before starting an embedded page", () => {
    const { state, parent, send } = fixture();
    const changed = vi.fn(); const stop = state.subscribe(changed);
    expect(state.active()).toBe(false);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: PAGE_ACTIVITY_REQUEST }, "http://localhost:3000");
    send(true); expect(state.active()).toBe(true);
    send(false); expect(state.active()).toBe(false);
    send(false); expect(changed).toHaveBeenCalledTimes(2);
    stop();
  });

  it("rejects foreign origins, unrelated frames, and malformed activity", () => {
    const { state, send } = fixture(); const stop = state.subscribe(vi.fn());
    send(true, "https://foreign.example"); send(true, undefined, {}); send("true");
    expect(state.active()).toBe(false);
    send(true); expect(state.active()).toBe(true); stop();
  });

  it("pauses on phone backgrounding and resumes only the selected frame", () => {
    const { state, send, document } = fixture(); const changed = vi.fn(); const stop = state.subscribe(changed);
    send(true);
    document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    expect(state.active()).toBe(false);
    send(false);
    document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
    expect(state.active()).toBe(false);
    send(true); expect(state.active()).toBe(true); stop();
  });

  it("keeps standalone desktop pages active and cleans up the final subscription", () => {
    const { state, document } = fixture(false); const changed = vi.fn();
    const stop = state.subscribe(changed); expect(state.active()).toBe(true); stop();
    document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).not.toHaveBeenCalled();
  });
});

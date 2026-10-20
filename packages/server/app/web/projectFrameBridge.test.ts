import { describe, expect, it, vi } from "vitest";
import { WEBAPP_PROJECT_REQUEST_TYPE, WEBAPP_PROJECT_RESPONSE_TYPE } from "../../../core/src/domain/web-console/WebProjectBridge";
import { WebShellProjectBridge } from "../../../webapp/src/infrastructure/web-shell-project-bridge";
import { forwardWebProjectRequest } from "./projectFrameBridge";

const origin = "http://localhost:3000";
const request = { type: WEBAPP_PROJECT_REQUEST_TYPE, id: 1, method: "project:roots", payload: {} };

describe("project requests from collaboration frames", () => {
  it("routes preview tickets back to their originating message frame", async () => {
    const listeners = new Set<EventListener>();
    const ticket = { ticketId: "ticket-1", url: "/api/web-console/file-preview/ticket-1" };
    const rpc = vi.fn(async (method: string) => method === "fs:preview-open" ? ticket : { revoked: true });
    const shell = { postMessage: (data: unknown) => {
      void forwardWebProjectRequest({ data, origin, source: frame }, origin, [frame], rpc);
    } };
    const frame = { postMessage: (data: unknown) => {
      listeners.forEach(listener => listener({ data, origin, source: shell } as unknown as Event));
    } } as unknown as Window;
    const bridge = new WebShellProjectBridge({
      location: { origin }, parent: shell,
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    } as never, 200);
    try {
      await expect(bridge.request("fs:preview-open", { path: "/tmp/cover.jpg" })).resolves.toEqual(ticket);
      await expect(bridge.request("fs:preview-close", { ticketId: "ticket-1" })).resolves.toEqual({ revoked: true });
      expect(rpc).toHaveBeenCalledWith("fs:preview-open", { path: "/tmp/cover.jpg" });
      expect(rpc).toHaveBeenCalledWith("fs:preview-close", { ticketId: "ticket-1" });
    } finally { bridge.dispose(); }
  });

  it("does not expose file writes through the preview bridge", async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const rpc = vi.fn();
    await expect(forwardWebProjectRequest({ data: { ...request, method: "fs:write" }, origin, source: frame }, origin, [frame], rpc)).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("completes directory initialization for both dashboard and group frames", async () => {
    const main = { postMessage: vi.fn() } as unknown as Window;
    const frames: Window[] = [main];
    const rpc = vi.fn(async (method: string) => method === "project:roots"
      ? { roots: ["/Users/example"], initialPath: "/Users/example/.agentroam" }
      : { entries: [{ name: "data", kind: "directory" }] });
    const bridges = Array.from({ length: 2 }, () => {
      const listeners = new Set<EventListener>();
      const shell = { postMessage: (data: unknown) => {
        void forwardWebProjectRequest({ data, origin, source: frame }, origin, frames, rpc);
      } };
      const frame = { postMessage: (data: unknown) => {
        for (const listener of listeners) listener({ data, origin, source: shell } as unknown as Event);
      } } as unknown as Window;
      frames.push(frame);
      return new WebShellProjectBridge({
        location: { origin }, parent: shell,
        addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
      } as never, 200);
    });
    try {
      // Both frames start with request id 1; responses must return to their own frame.
      const locations = await Promise.all(bridges.map(bridge => bridge.request("project:roots")));
      expect(locations).toEqual(Array(2).fill({ roots: ["/Users/example"], initialPath: "/Users/example/.agentroam" }));
      await expect(bridges[0].request("project:directories", { path: "/Users/example/.agentroam" }))
        .resolves.toEqual({ entries: [{ name: "data", kind: "directory" }] });
      expect(main.postMessage).not.toHaveBeenCalled();
    } finally {
      bridges.forEach(bridge => bridge.dispose());
    }
  });

  it("rejects unregistered frames and other origins", async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const rpc = vi.fn();
    await expect(forwardWebProjectRequest({ data: request, origin, source: {} as Window }, origin, [frame, null], rpc)).resolves.toBe(false);
    await expect(forwardWebProjectRequest({ data: request, origin: "https://other", source: frame }, origin, [frame], rpc)).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns directory access errors to the requesting frame", async () => {
    const main = { postMessage: vi.fn() } as unknown as Window;
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const rpc = vi.fn().mockRejectedValue(Object.assign(new Error("目录不可访问"), { code: "PATH_OUTSIDE_ROOT" }));
    await forwardWebProjectRequest({ data: request, origin, source: frame }, origin, [main, frame], rpc);
    expect(frame.postMessage).toHaveBeenCalledWith({ type: WEBAPP_PROJECT_RESPONSE_TYPE, id: 1, ok: false, error: "目录不可访问", code: "PATH_OUTSIDE_ROOT" }, origin);
    expect(main.postMessage).not.toHaveBeenCalled();
  });
});

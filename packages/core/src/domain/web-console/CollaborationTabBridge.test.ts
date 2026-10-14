import { describe, expect, it } from "vitest";
import {
  COLLABORATION_OPEN_TYPE,
  COLLABORATION_CREATE_TYPE,
  COLLABORATION_CHANGED_TYPE,
  COLLABORATION_CONTENT_READY_TYPE,
  COLLABORATION_DASHBOARD_READY_TYPE,
  readCollaborationContentReady,
  readCollaborationChanged,
  readCollaborationCreate,
  readCollaborationOpen,
} from "./CollaborationTabBridge.js";
describe("collaboration tab messages", () => {
  it("reveals the dashboard only for its own content-ready signal and frame", () => {
    const frame = {} as Window;
    const event = { source: frame, origin: "http://localhost", data: { type: COLLABORATION_DASHBOARD_READY_TYPE } };
    expect(readCollaborationContentReady(event, event.origin, frame, null)).toBe(true);
    expect(readCollaborationContentReady(event, event.origin, frame, "g")).toBe(false);
    expect(readCollaborationContentReady(event, event.origin, {} as Window, null)).toBe(false);
    expect(readCollaborationContentReady({ ...event, origin: "https://other" }, event.origin, frame, null)).toBe(false);
    for (const data of [null, [], { type: COLLABORATION_CONTENT_READY_TYPE, groupId: "g" }, { type: "agent-webapp:ready:v1" }])
      expect(readCollaborationContentReady({ ...event, data }, event.origin, frame, null)).toBe(false);
  });

  it("reveals a group only for content readiness from its own same-origin frame", () => {
    const frame = {} as Window;
    const event = { source: frame, origin: "http://localhost", data: { type: COLLABORATION_CONTENT_READY_TYPE, groupId: "g" } };
    expect(readCollaborationContentReady(event, event.origin, frame, "g")).toBe(true);
    expect(readCollaborationContentReady(event, event.origin, frame, "other-group")).toBe(false);
    expect(readCollaborationContentReady(event, event.origin, {} as Window, "g")).toBe(false);
    expect(readCollaborationContentReady(event, event.origin, null, "g")).toBe(false);
    expect(readCollaborationContentReady({ ...event, origin: "https://other" }, event.origin, frame, "g")).toBe(false);
    expect(readCollaborationContentReady({ ...event, data: { ...event.data, type: "agent-webapp:ready:v1" } }, event.origin, frame, "g")).toBe(false);
  });

  it("accepts dashboard mutation events only from its same-origin frame", () => {
    const frame = {} as Window;
    const event = { source: frame, origin: "http://localhost", data: { type: COLLABORATION_CHANGED_TYPE, groupId: "g", deleted: true } };
    expect(readCollaborationChanged(event, event.origin, frame)).toEqual({ groupId: "g", deleted: true });
    expect(readCollaborationChanged(event, event.origin, {} as Window)).toBeNull();
    expect(readCollaborationChanged({ ...event, origin: "https://other" }, event.origin, frame)).toBeNull();
    expect(readCollaborationChanged({ ...event, data: { ...event.data, groupId: "../invalid" } }, event.origin, frame)).toBeNull();
    expect(readCollaborationChanged({ ...event, data: { type: COLLABORATION_CHANGED_TYPE, groupId: "g", title: "新名" } }, event.origin, frame)).toEqual({ groupId: "g", title: "新名" });
  });

  it("accepts creation only from the expected shell parent and origin", () => {
    const parent = {} as Window;
    const event = {
      source: parent,
      origin: "http://localhost",
      data: { type: COLLABORATION_CREATE_TYPE },
    };
    expect(readCollaborationCreate(event, event.origin, parent)).toBe(true);
    expect(readCollaborationCreate(event, event.origin, null)).toBe(false);
    expect(readCollaborationCreate(event, event.origin, {} as Window)).toBe(false);
    expect(readCollaborationCreate({ ...event, origin: "https://other" }, event.origin, parent)).toBe(false);
    for (const data of [null, [], "create", { type: COLLABORATION_OPEN_TYPE }]) {
      expect(readCollaborationCreate({ ...event, data }, event.origin, parent)).toBe(false);
    }
  });

  it("accepts only the expected frame and origin and a bounded group identifier", () => {
    const frame = {} as Window;
    const event = {
      source: frame,
      origin: "http://localhost",
      data: {
        type: COLLABORATION_OPEN_TYPE,
        groupId: "group-1",
        title: "协作群",
      },
    };
    expect(readCollaborationOpen(event, "http://localhost", frame)).toEqual({
      groupId: "group-1",
      title: "协作群",
    });
    expect(
      readCollaborationOpen(
        { ...event, origin: "https://other" },
        event.origin,
        frame,
      ),
    ).toBeNull();
    expect(readCollaborationOpen(event, event.origin, {} as Window)).toBeNull();
    expect(
      readCollaborationOpen(
        { ...event, data: { ...event.data, groupId: "../bad" } },
        event.origin,
        frame,
      ),
    ).toBeNull();
  });
});

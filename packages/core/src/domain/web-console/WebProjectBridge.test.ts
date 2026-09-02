import { describe, expect, it } from "vitest";
import {
  WEBAPP_PROJECT_REQUEST_TYPE,
  WEBAPP_PROJECT_RESPONSE_TYPE,
  parseWebProjectRequest,
  parseWebProjectResponse,
  readWebProjectRequest,
} from "./WebProjectBridge";

describe("web project bridge contract", () => {
  const request = {
    type: WEBAPP_PROJECT_REQUEST_TYPE,
    id: 3,
    method: "project:create",
    payload: { path: "/tmp/project" },
  };

  it("accepts an allowlisted request from the expected frame", () => {
    const source = {} as MessageEventSource;
    expect(readWebProjectRequest(
      { data: request, origin: "https://agent.test", source },
      "https://agent.test",
      source,
    )).toEqual(request);
  });

  it("rejects unknown methods, bad ids, origins, and sources", () => {
    expect(parseWebProjectRequest({ ...request, method: "fs:read" })).toBeNull();
    expect(parseWebProjectRequest({ ...request, id: Number.NaN })).toBeNull();
    expect(readWebProjectRequest(
      { data: request, origin: "https://evil.test", source: null },
      "https://agent.test",
      null,
    )).toBeNull();
    expect(readWebProjectRequest(
      { data: request, origin: "https://agent.test", source: {} as MessageEventSource },
      "https://agent.test",
      null,
    )).toBeNull();
  });

  it("parses correlated success and error responses", () => {
    expect(parseWebProjectResponse({
      type: WEBAPP_PROJECT_RESPONSE_TYPE,
      id: 3,
      ok: true,
      result: { projects: [] },
    })?.ok).toBe(true);
    expect(parseWebProjectResponse({
      type: WEBAPP_PROJECT_RESPONSE_TYPE,
      id: 3,
      ok: false,
      error: "denied",
      code: "PATH_OUTSIDE_ROOT",
    })?.code).toBe("PATH_OUTSIDE_ROOT");
  });
});

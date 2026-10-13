import { describe, expect, it } from "vitest";
import {
  WEBAPP_ARTIFACT_OPEN_TYPE,
  parseWebArtifactOpenRequest,
  readWebArtifactOpenRequest,
} from "./WebArtifactBridge";

describe("web artifact bridge contract", () => {
  const request = {
    type: WEBAPP_ARTIFACT_OPEN_TYPE,
    requestId: 7,
    path: "/Users/example/project/outputs/report.pdf",
  };

  it("accepts an absolute file request from the expected frame", () => {
    const source = {} as MessageEventSource;
    expect(readWebArtifactOpenRequest(
      { data: request, origin: "https://agent.test", source },
      "https://agent.test",
      source,
    )).toEqual(request);
  });

  it("accepts Windows drive-letter and UNC absolute paths", () => {
    expect(parseWebArtifactOpenRequest({ ...request, path: "C:\\Users\\example\\report.pdf" }))
      .toEqual({ ...request, path: "C:\\Users\\example\\report.pdf" });
    expect(parseWebArtifactOpenRequest({ ...request, path: "\\\\server\\share\\report.pdf" }))
      .toEqual({ ...request, path: "\\\\server\\share\\report.pdf" });
  });

  it("accepts host-home paths and HTTP media URLs without accepting arbitrary schemes", () => {
    for (const path of ["~/videos/demo.mp4", "https://cdn.example/demo.mp4?signature=abc"]) {
      expect(parseWebArtifactOpenRequest({ ...request, path })).toEqual({ ...request, path });
    }
    for (const path of ["javascript:demo.mp4", "https://example.com/docs", "https://example.com/demo.mp4\n"]) {
      expect(parseWebArtifactOpenRequest({ ...request, path })).toBeNull();
    }
  });

  it("rejects invalid ids and unsafe paths", () => {
    expect(parseWebArtifactOpenRequest({ ...request, requestId: 0 })).toBeNull();
    expect(parseWebArtifactOpenRequest({ ...request, requestId: Number.NaN })).toBeNull();
    expect(parseWebArtifactOpenRequest({ ...request, path: "outputs/report.pdf" })).toBeNull();
    expect(parseWebArtifactOpenRequest({ ...request, path: "" })).toBeNull();
    expect(parseWebArtifactOpenRequest({ ...request, path: "/tmp/bad\0name" })).toBeNull();
    expect(parseWebArtifactOpenRequest({ ...request, path: "/tmp/bad\nname" })).toBeNull();
  });

  it("rejects requests from another origin or frame", () => {
    const source = {} as MessageEventSource;
    expect(readWebArtifactOpenRequest(
      { data: request, origin: "https://evil.test", source },
      "https://agent.test",
      source,
    )).toBeNull();
    expect(readWebArtifactOpenRequest(
      { data: request, origin: "https://agent.test", source: {} as MessageEventSource },
      "https://agent.test",
      source,
    )).toBeNull();
  });
});

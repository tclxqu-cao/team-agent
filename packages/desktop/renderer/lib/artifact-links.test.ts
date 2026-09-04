import { WEBAPP_ARTIFACT_OPEN_TYPE } from "../../../core/src/domain/web-console/WebArtifactBridge";
import { describe, expect, it, vi } from "vitest";
import { postWebArtifactOpen, resolveWebArtifactPath } from "./artifact-links";

describe("postWebArtifactOpen", () => {
  it("posts a same-origin request to the parent shell", () => {
    const parent = { postMessage: vi.fn() };
    const context = { location: { origin: "https://agent.test" }, parent };

    expect(postWebArtifactOpen("/tmp/report.pdf", context as never)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: WEBAPP_ARTIFACT_OPEN_TYPE,
      requestId: expect.any(Number),
      path: "/tmp/report.pdf",
    }, "https://agent.test");
  });

  it("does nothing when the renderer is not inside the Web shell", () => {
    const context = { location: { origin: "https://agent.test" } } as {
      location: { origin: string };
      parent: unknown;
    };
    context.parent = context;

    expect(postWebArtifactOpen("/tmp/report.pdf", context as never)).toBe(false);
  });
});

describe("resolveWebArtifactPath", () => {
  it("keeps absolute paths and resolves project-relative paths", () => {
    expect(resolveWebArtifactPath("/tmp/report.md", "/work/project")).toBe("/tmp/report.md");
    expect(resolveWebArtifactPath("packages/app.tsx", "/work/project/")).toBe("/work/project/packages/app.tsx");
    expect(resolveWebArtifactPath("src\\app.tsx", "C:\\work\\project")).toBe("C:\\work\\project\\src\\app.tsx");
  });

  it("rejects traversal, control characters, and missing workspace roots", () => {
    expect(resolveWebArtifactPath("../secret", "/work/project")).toBeNull();
    expect(resolveWebArtifactPath("bad\nname", "/work/project")).toBeNull();
    expect(resolveWebArtifactPath("relative.md", null)).toBeNull();
  });
});

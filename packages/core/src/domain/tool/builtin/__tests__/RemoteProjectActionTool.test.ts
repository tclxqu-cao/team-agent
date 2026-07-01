import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RemoteProjectActionTool } from "../RemoteProjectActionTool.js";

describe("RemoteProjectActionTool", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.REMOTE_PROJECT_ACTIONS = JSON.stringify({
      create_kid_earth_course: {
        url: "http://kid.test/api/agent-actions/create-course",
        description: "创建并发布 Kid Earth 课程。payload 只需要 title、topic、chapterCount、ageRange。",
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.REMOTE_PROJECT_ACTIONS;
    vi.restoreAllMocks();
  });

  it("posts the selected action payload to its registered remote endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, courseId: 9, title: "揭秘太阳" }), { status: 200 });
    }) as typeof fetch;

    const result = await new RemoteProjectActionTool().execute(
      {
        action: "create_kid_earth_course",
        payload: { title: "揭秘太阳", topic: "太阳", chapterCount: 4, ageRange: "4 岁" },
      },
      { workingDirectory: "/tmp", sessionId: "s1" },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("courseId");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kid.test/api/agent-actions/create-course");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      action: "create_kid_earth_course",
      payload: { title: "揭秘太阳", topic: "太阳", chapterCount: 4, ageRange: "4 岁" },
    });
  });

  it("lists registered actions in the tool description", () => {
    expect(new RemoteProjectActionTool().description).toContain("create_kid_earth_course");
    expect(new RemoteProjectActionTool().description).toContain("创建并发布 Kid Earth 课程");
  });
});

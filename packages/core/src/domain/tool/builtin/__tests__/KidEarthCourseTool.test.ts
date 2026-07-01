import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KidEarthCourseTool } from "../KidEarthCourseTool.js";

const chapter = {
  sortOrder: 0,
  title: "揭秘太阳",
  shortTitle: "太阳",
  icon: "☀️",
  sceneKey: "revolution",
  narration: "太阳照亮地球，带来温暖。",
  tapPrompt: "点一点太阳。",
  guide: "观察太阳光。",
  questionTitle: "太阳为什么重要？",
  questionText: "太阳给地球带来了什么？",
  choices: ["光和热", "雪花", "石头"],
  answerIndex: 0,
  feedback: "答对啦！太阳给我们光和热。",
  funFact: "太阳是一颗恒星。",
  parentPrompt: "和孩子聊聊白天为什么明亮。",
};

describe("KidEarthCourseTool", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.KID_EARTH_BASE_URL = "http://kid.test";
    process.env.KID_EARTH_ADMIN_USERNAME = "admin";
    process.env.KID_EARTH_ADMIN_PASSWORD = "secret";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.KID_EARTH_BASE_URL;
    delete process.env.KID_EARTH_ADMIN_USERNAME;
    delete process.env.KID_EARTH_ADMIN_PASSWORD;
    vi.restoreAllMocks();
  });

  it("creates, fills, and publishes a kid-earth course", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const path = String(url).replace("http://kid.test", "");
      if (path === "/api/admin/login") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "set-cookie": "sid=abc; Path=/" } });
      }
      if (path === "/api/admin/courses") {
        return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      }
      if (path === "/api/admin/courses/42") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === "/api/admin/courses/42/ai/chapters") {
        return new Response(JSON.stringify({ ids: [7] }), { status: 200 });
      }
      if (path === "/api/admin/courses/42/publish") {
        return new Response(JSON.stringify({ ok: true, course: { id: 42, title: "揭秘太阳", status: "published" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await new KidEarthCourseTool().execute(
      {
        title: "揭秘太阳",
        slug: "secret-sun",
        ageRange: "4 岁",
        publish: true,
        chapters: [chapter],
      },
      { workingDirectory: "/tmp", sessionId: "s1" },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("课程已创建");
    expect(result.content).toContain("42");
    expect(calls.map((c) => c.url)).toEqual([
      "http://kid.test/api/admin/login",
      "http://kid.test/api/admin/courses",
      "http://kid.test/api/admin/courses/42",
      "http://kid.test/api/admin/courses/42/ai/chapters",
      "http://kid.test/api/admin/courses/42/publish",
    ]);
    expect(JSON.parse(calls[2].init?.body as string)).toMatchObject({
      title: "揭秘太阳",
      slug: "secret-sun",
      ageRange: "4 岁",
      status: "draft",
    });
  });
});

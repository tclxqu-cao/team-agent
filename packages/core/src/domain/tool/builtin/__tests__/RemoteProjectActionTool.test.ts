import { describe, expect, it } from "vitest";
import { RemoteProjectActionTool } from "../RemoteProjectActionTool.js";

describe("RemoteProjectActionTool default constructor", () => {
  it("does not execute remote actions without a configured registry store", async () => {
    const result = await new RemoteProjectActionTool().execute(
      { action: "create_kid_earth_course", payload: { title: "揭秘太阳" } },
      { workingDirectory: "/tmp", sessionId: "s1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Remote tool registry is not configured");
  });

  it("does not list REMOTE_PROJECT_ACTIONS env registrations", () => {
    process.env.REMOTE_PROJECT_ACTIONS = JSON.stringify({
      create_kid_earth_course: {
        url: "http://kid.test/api/agent-actions/create-course",
        description: "创建并发布 Kid Earth 课程。payload 只需要 title、topic、chapterCount、ageRange。",
      },
    });

    try {
      expect(new RemoteProjectActionTool().description).not.toContain("create_kid_earth_course");
      expect(new RemoteProjectActionTool().description).toContain("No remote actions are registered.");
    } finally {
      delete process.env.REMOTE_PROJECT_ACTIONS;
    }
  });
});

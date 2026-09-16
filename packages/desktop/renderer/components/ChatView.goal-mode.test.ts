import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

describe("ChatView goal mode visibility", () => {
  it("removes the duplicate setup bar while keeping composer goal mode", () => {
    expect(chatView).not.toContain('className="goal-queue thread-goal-setup"');
    expect(chatView).not.toContain("设定目标，完成后每轮空闲自动续跑推进");
    expect(chatView).toContain('aria-label={goalMode ? "关闭目标模式" : "开启目标模式"}');
    expect(chatView).toContain('const goalObjective = explicitGoal ? explicitGoal[1]?.trim() ?? "" : goalMode ? finalMsg : null');
  });
});

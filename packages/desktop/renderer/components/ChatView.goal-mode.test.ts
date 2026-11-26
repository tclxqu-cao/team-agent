import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

describe("ChatView goal mode visibility", () => {
  it("removes the duplicate setup bar while keeping composer goal mode", () => {
    expect(chatView).not.toContain('className="goal-queue thread-goal-setup"');
    expect(chatView).not.toContain("设定目标，完成后每轮空闲自动续跑推进");
    expect(chatView).toContain('aria-label={goalMode ? "关闭目标模式" : "开启目标模式"}');
    expect(chatView).toContain("submission.applyGoalMode && goalMode ? finalMsg : null");
  });

  it("gives the background jobs and goal queue separate identities within a DeepSeek session", () => {
    const jobsKey = chatView.match(/<SessionBackgroundJobs\s+key=\{(\S+)\}\s/)?.[1];
    const queueKey = chatView.match(/<SessionGoalQueue\s+key=\{(\S+)\}\s/)?.[1];

    expect(jobsKey).toContain("viewSessionId");
    expect(queueKey).toContain("viewSessionId");
    expect(jobsKey).not.toBe(queueKey);
  });

  it("keeps active goal controls behind the header button and only waiting goals in the composer", () => {
    const composerStart = chatView.indexOf('className="chat-input-area"');
    expect(composerStart).toBeGreaterThan(0);
    const header = chatView.slice(chatView.indexOf('className="chat-top-bar"'), chatView.indexOf('className="chat-messages"'));
    expect(header).toContain('aria-label="查看会话目标"');
    expect(header).toContain('hasGoalDetails && showGoalDetails && <section');
    expect(header).toContain("active={activeSessionGoal}");
    const composer = chatView.slice(composerStart);
    expect(composer).toContain("queued={goalState.queued}");
    expect(composer).not.toMatch(/<SessionGoalQueue[^>]*\sactive=|<NativeGoalBar|currentThreadGoal\.objective/);
  });
});

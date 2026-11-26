import { describe, expect, it } from "vitest";
import { completedWorkTitles } from "./completed-work";

const plan = [{ id: "step", title: "CrossDesk 调研", status: "completed" as const }];

describe("ordinary Todo completion evidence", () => {
  it.each([
    ["CrossDesk 调研已完成。", "收到"],
    ["CrossDesk 调研已经完成。结论是浏览器用 WebRTC。", "收到"],
    ["请帮我做一下 CrossDesk 调研", "**CrossDesk 调研已完成**。浏览器使用 WebRTC。"],
  ])("recognizes a named completion in %s", (input, answer) => {
    expect(completedWorkTitles(input, answer, [])).toEqual(["CrossDesk 调研"]);
  });
  it("uses only completed plan items and respects an explicit hold", () => {
    expect(completedWorkTitles("继续", "结果如下", plan)).toEqual(["CrossDesk 调研"]);
    expect(completedWorkTitles("这次不要同步待办", "已完成", plan)).toEqual([]);
    expect(completedWorkTitles("继续", "已完成", [...plan, { ...plan[0], status: "pending" }])).toEqual([]);
  });
  it.each([
    ["CrossDesk 调研完成了吗？", "暂未完成"],
    ["用 CrossDesk 调研做例句", "CrossDesk 调研已完成。"],
    ["解释 CrossDesk 调研", "谈到了 CrossDesk"],
    ["继续", "全部完成"],
  ])("does not equate an ordinary answer with calendar completion", (input, answer) => {
    expect(completedWorkTitles(input, answer, [])).not.toContain("CrossDesk 调研");
  });
});

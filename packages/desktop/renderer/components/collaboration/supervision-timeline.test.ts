import { expect, it } from "vitest";
import type { SupervisionMessage } from "../../../../core/src/domain/supervision/types";
import { groupTimeline, mergeSupervisionMessages } from "./supervision-timeline";

const message = (id: string, time: string, sequence: number): SupervisionMessage => ({ id, groupId: "g", direction: "received", title: "进展", sender: "原会话", content: id, createdAt: time, sequence });
it("merges polling and older pages without losing or duplicating messages", () => {
  const one = message("one", "2026-11-02T12:00:00Z", 1), two = message("two", "2026-11-02T12:00:01Z", 2), three = message("three", "2026-11-02T12:00:02Z", 3);
  expect(mergeSupervisionMessages([two], [three, two, one]).map(message => message.id)).toEqual(["one", "two", "three"]);
});
it("interleaves ordinary discussion and supervision chronologically and retains normal chat filtering", () => {
  const result = groupTimeline([
    { id: "chat", kind: "user", content: "继续", createdAt: "2026-11-02T12:00:01Z" },
    { id: "hidden-progress", kind: "progress", content: "运行中", createdAt: "2026-11-02T12:00:01Z" },
  ], [message("after", "2026-11-02T12:00:02Z", 2), message("before", "2026-11-02T12:00:00Z", 1)]);
  expect(result.map(entry => [entry.kind, entry.message.id])).toEqual([["supervision", "before"], ["discussion", "chat"], ["supervision", "after"]]);
});

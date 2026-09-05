import { describe, expect, it } from "vitest";
import type { Message } from "../model/entities.js";
import {
  StaleSessionAnchorError,
  buildSessionQueryIndex,
  computeSessionHistoryRevision,
} from "./SessionQueryIndex.js";
import { paginateSessionHistory } from "./SessionHistory.js";

function user(content: string, extra: Partial<Message> = {}): Message {
  return { role: "user", content, ...extra };
}

function assistant(content: string): Message {
  return { role: "assistant", content };
}

describe("session query index", () => {
  it("keeps duplicate query text as distinct ordered entries", () => {
    const messages = [user("same query"), assistant("a"), user("same query"), assistant("b")];
    const index = buildSessionQueryIndex("session-1", messages);

    expect(index.entries.map((entry) => [entry.ordinal, entry.preview])).toEqual([
      [1, "same query"],
      [2, "same query"],
    ]);
    expect(index.entries[0].messageId).not.toBe(index.entries[1].messageId);
  });

  it("normalizes previews and excludes blank and internal boundaries", () => {
    const messages = [
      user("  first\n\tquery  "),
      user(""),
      user("", { images: ["data:image/png;base64,x"] }),
      user("interrupt", { name: "__interrupt__" }),
      user("summary", { name: "__compaction_checkpoint__" }),
    ];

    expect(buildSessionQueryIndex("session-1", messages).entries.map((entry) => entry.preview)).toEqual([
      "first query",
      "图片消息",
    ]);
  });

  it("resolves every anchor to a page containing its target message", () => {
    const messages = Array.from({ length: 24 }, (_, index) => (
      index % 2 === 0 ? user(`query ${index / 2 + 1}`) : assistant(`answer ${index / 2 + 1}`)
    ));
    const index = buildSessionQueryIndex("session-1", messages);

    for (const entry of index.entries) {
      const page = paginateSessionHistory(messages, [], { anchor: entry.pageToken, limit: 5 });
      expect(page.messages.some((message) => message.historyId === entry.messageId)).toBe(true);
      expect(page.history.kind).toBe("anchored");
    }
  });

  it("keeps the target when rewinding across an unusually long previous turn", () => {
    const messages: Message[] = [
      user("long turn"),
      ...Array.from({ length: 60 }, (_, index) => assistant(`update ${index + 1}`)),
      user("target query"),
      assistant("target answer"),
    ];
    const target = buildSessionQueryIndex("session-1", messages).entries[1];

    const page = paginateSessionHistory(messages, [], {
      anchor: target.pageToken,
      limit: 10,
    });

    expect(page.messages.some((message) => message.historyId === target.messageId)).toBe(true);
    expect(page.messages.at(-1)).toMatchObject({ role: "assistant", content: "target answer" });
  });

  it("returns contiguous older and newer cursors around an anchor", () => {
    const messages = Array.from({ length: 20 }, (_, index) => (
      index % 2 === 0 ? user(`q${index / 2}`) : assistant(`a${index / 2}`)
    ));
    const entry = buildSessionQueryIndex("session-1", messages).entries[5];
    const anchor = paginateSessionHistory(messages, [], { anchor: entry.pageToken, limit: 4 });
    const older = paginateSessionHistory(messages, [], { before: anchor.history.olderCursor!, limit: 4 });
    const newer = paginateSessionHistory(messages, [], { after: anchor.history.newerCursor!, limit: 4 });

    const anchorIds = new Set(anchor.messages.map((message) => message.historyId));
    expect(older.messages.every((message) => !anchorIds.has(message.historyId))).toBe(true);
    expect(newer.messages.every((message) => !anchorIds.has(message.historyId))).toBe(true);
    expect(older.history.newerCursor).toBe(anchor.history.olderCursor);
    expect(newer.history.olderCursor).toBe(anchor.history.newerCursor);
  });

  it("changes revision on append and rejects the old anchor", () => {
    const messages = [user("q1"), assistant("a1")];
    const oldIndex = buildSessionQueryIndex("session-1", messages);
    const appended = [...messages, user("q2")];

    expect(computeSessionHistoryRevision(appended)).not.toBe(oldIndex.revision);
    expect(buildSessionQueryIndex("session-1", appended).entries[0].messageId)
      .toBe(oldIndex.entries[0].messageId);
    expect(() => paginateSessionHistory(appended, [], {
      anchor: oldIndex.entries[0].pageToken,
      limit: 5,
    })).toThrow(StaleSessionAnchorError);
  });
});

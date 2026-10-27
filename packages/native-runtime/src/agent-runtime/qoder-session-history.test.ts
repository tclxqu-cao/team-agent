import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeQoderHistory, QoderSessionHistory } from "./qoder-session-history.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const row = (uuid: string, parentUuid: string | null, type: "user" | "assistant", text: string) => ({
  uuid, parentUuid, type, message: { role: type, content: [{ type: "text", text }] },
});

describe("Qoder native transcript history", () => {
  it("follows the active native branch through non-message parent records", () => {
    const messages = decodeQoderHistory([
      row("request", null, "user", "Change the document only"),
      { uuid: "attachment", parentUuid: "request", type: "attachment" },
      row("document", "attachment", "assistant", "Document completed"),
      row("question", "document", "user", "Which model?"),
      row("failure", "question", "assistant", "Queue recovery exceeded"),
      { ...row("other-branch", "request", "assistant", "Unselected answer"), isSidechain: true },
      { type: "active-leaf", sessionId: "native", leafUuid: "failure" },
    ], "native");
    expect(messages.map(message => message.content)).toEqual(["Change the document only", "Document completed", "Which model?", "Queue recovery exceeded"]);
    expect(messages.map(message => message.historyId)).toEqual(["request", "document", "question", "failure"]);
  });

  it("does not concatenate different native messages or repeated user questions", () => {
    const messages = decodeQoderHistory([
      row("u1", null, "user", "Which model?"),
      row("a1", "u1", "assistant", "Commentary"),
      row("a2", "a1", "assistant", "Final answer"),
      row("u2", "a2", "user", "Which model?"),
      row("u3", "u2", "user", "Which model?"),
    ], "native");
    expect(messages).toHaveLength(5);
    expect(messages.map(message => message.historyId)).toEqual(["u1", "a1", "a2", "u2", "u3"]);
  });

  it("honors the selected branch rather than file tail or timestamps", () => {
    const messages = decodeQoderHistory([
      row("u", null, "user", "Question"),
      { ...row("chosen", "u", "assistant", "Chosen answer"), timestamp: 300 },
      { ...row("abandoned", "u", "assistant", "Abandoned answer"), timestamp: 400 },
      { type: "active-leaf", sessionId: "native", leafUuid: "chosen" },
      { type: "active-leaf", sessionId: "other-session", leafUuid: "abandoned" },
    ], "native");
    expect(messages.map(message => message.content)).toEqual(["Question", "Chosen answer"]);
  });

  it("keeps hidden native context in the parent chain without displaying it as user input", () => {
    const messages = decodeQoderHistory([
      row("u", null, "user", "Question"),
      { ...row("meta", "u", "user", "Internal context"), isMeta: true },
      { ...row("summary", "meta", "user", "Compacted context"), isCompactSummary: true },
      { ...row("internal", "summary", "user", "Internal transcript context"), isVisibleInTranscriptOnly: true },
      row("answer", "internal", "assistant", "Answer"),
    ], "native");
    expect(messages.map(message => message.content)).toEqual(["Question", "Answer"]);
    expect(messages.map(message => message.historyId)).toEqual(["u", "answer"]);
  });

  it("does not resurrect old messages after the native active branch is cleared", () => {
    expect(decodeQoderHistory([
      row("u", null, "user", "Previous question"), { type: "active-leaf", sessionId: "native", leafUuid: null },
    ], "native")).toEqual([]);
  });

  it("retains reasoning, tool identities, results and errors without fake user turns", () => {
    const messages = decodeQoderHistory([
      row("u", null, "user", "Inspect files"),
      { uuid: "a", parentUuid: "u", type: "assistant", message: { content: [
        { type: "thinking", thinking: "Check first" }, { type: "text", text: "Reading" },
        { type: "tool_use", id: "read", name: "Read", input: { file: "README" } },
      ] } },
      { uuid: "result", parentUuid: "a", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: [{ type: "text", text: "Denied" }], is_error: true }] } },
      row("final", "result", "assistant", "Cannot read"),
    ], "native");
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({ historyId: "a", content: "Reading", presentation: { reasoning: [{ text: "Check first" }] }, toolCalls: [{ id: "read", name: "Read", arguments: { file: "README" } }] });
    expect(messages[2]).toMatchObject({ role: "tool", content: "Denied", toolCallId: "read", isError: true });
  });

  it("uses the latest revision of a UUID without moving it or losing stable identities", () => {
    const messages = decodeQoderHistory([
      row("u", null, "user", "Question"), row("a", "u", "assistant", "Partial"),
      row("next", "a", "user", "Next question"), row("a", "u", "assistant", "Complete"),
      { type: "active-leaf", sessionId: "native", leafUuid: "next" },
    ], "native");
    expect(messages.map(message => message.content)).toEqual(["Question", "Complete", "Next question"]);
  });

  it("fails closed for corrupt selected branches instead of mixing branches", () => {
    expect(() => decodeQoderHistory([
      row("a", "b", "assistant", "A"), row("b", "a", "assistant", "B"),
      { type: "active-leaf", sessionId: "native", leafUuid: "b" },
    ], "native")).toThrow("cycle");
    expect(() => decodeQoderHistory([
      row("u", null, "user", "Question"), { type: "active-leaf", sessionId: "native", leafUuid: "missing" },
    ], "native")).toThrow("leaf");
  });

  it("reads fresh native snapshots and ignores an uncommitted JSONL tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "qoder-history-")); roots.push(root);
    const directory = join(root, "native-project"); await mkdir(directory);
    const path = join(directory, "native.jsonl");
    await writeFile(path, JSON.stringify(row("u", null, "user", "Question")) + "\n{\"unfinished\":");
    const history = new QoderSessionHistory(root);
    expect((await history.read("native")).map(message => message.content)).toEqual(["Question"]);
    await writeFile(path, [row("u", null, "user", "Question"), row("a", "u", "assistant", "Fresh answer")].map(value => JSON.stringify(value)).join("\n") + "\n");
    expect((await history.read("native")).map(message => message.content)).toEqual(["Question", "Fresh answer"]);
  });

  it("reports missing native history and rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "qoder-history-")); roots.push(root);
    const history = new QoderSessionHistory(root);
    await expect(history.read("missing")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(history.read("../outside")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

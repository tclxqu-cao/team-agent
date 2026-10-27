import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent/core";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { WorkBuddyRuntimeAdapter } from "./workbuddy-runtime-adapter.js";
import { decodeWorkBuddyHistory, WorkBuddySessionCatalog } from "./workbuddy-session-catalog.js";

const roots: string[] = [];
const clients: WorkBuddyClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-adapter-")); roots.push(root);
  const catalog = new WorkBuddySessionCatalog(root);
  const makeClient = () => {
    const client = new WorkBuddyClient({ catalog, command: async () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/workbuddy-protocol-fixture.cjs", import.meta.url))], env: { CATALOG_ROOT: root } }) });
    clients.push(client); return client;
  };
  return { root, catalog, makeClient, client: makeClient() };
}
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }

describe("WorkBuddy native stream-json adapter", () => {
  it("matches nested control response IDs and never exposes native account credentials", async () => {
    const { client } = await fixture();
    const models = await client.listModels();
    expect(models).toEqual([{ id: "native-workbuddy", displayName: "Native WorkBuddy", description: undefined }]);
    expect(JSON.stringify(models)).not.toContain("must-not-leak");
  });

  it("creates a native draft and streams each text exactly once", async () => {
    const { client, root } = await fixture(); const adapter = new WorkBuddyRuntimeAdapter(client);
    const created = await adapter.create({ title: "Native draft", cwd: root });
    expect((await adapter.getSession(created.nativeSessionId)).messages).toEqual([]);
    const events = await collect(adapter.run(created.nativeSessionId, "hello"));
    expect(events).toEqual([{ type: "text_chunk", text: "native answer" }, { type: "done", finalText: "native answer" }]);
    expect((await adapter.getSession(created.nativeSessionId)).messages.map(message => message.content)).toEqual(["hello", "native answer"]);
  });

  it.each([
    ["NATIVE_AUTH_REQUIRED", "AUTHENTICATION_REQUIRED", "required"],
    ["NATIVE_AUTH_FAILED", "AUTHENTICATION_FAILED", "failed"],
  ])("does not accept the native synthetic %s notice as a successful model response", async (input, code, reason) => {
    const { client, root } = await fixture(); const session = await client.create({ title: "Native authentication", cwd: root });
    const events = await collect(client.run(session.id, input));
    expect(events.at(-1)).toEqual({ type: "error", code, message: `Authentication ${reason}. Please use /login command to sign in to your account` });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  it.each(["QUOTE_AUTH_NOTICE", "UNKNOWN_MODEL_QUOTE"])("does not misclassify a generated answer quoting the native login notice (%s)", async input => {
    const { client, root } = await fixture(); const session = await client.create({ title: "Quoted notice", cwd: root });
    const events = await collect(client.run(session.id, input));
    expect(events.at(-1)).toEqual({ type: "done", finalText: "Authentication required. Please use /login command to sign in to your account" });
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  it("resumes the native ID and context in a new process/client rather than replaying a CA transcript", async () => {
    const { client, root, makeClient } = await fixture();
    const created = await client.create({ title: "Context", cwd: root });
    await collect(client.run(created.id, "REMEMBER AGENTROAM_NATIVE_CONTEXT"));
    await client.dispose();
    const resumed = makeClient();
    const events = await collect(resumed.run(created.id, "RECALL"));
    expect(events.at(-1)).toEqual({ type: "done", finalText: "AGENTROAM_NATIVE_CONTEXT" });
  });

  it("requires an explicit permission answer even if arbitrary tool input contains questions", async () => {
    const { client, root } = await fixture(); const session = await client.create({ title: "Permission", cwd: root });
    const iterator = client.run(session.id, "PERMISSION")[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.value.type !== "ask_user") throw new Error("Missing approval");
    expect(first.value.question).toContain("WriteFile requests permission");
    await expect(client.answerQuestion(first.value.questionId, { answer: "arbitrary" })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    await client.answerQuestion(first.value.questionId, { answer: "Deny", selectedIndices: [1] });
    const events: AgentEvent[] = []; for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
    expect(events.at(-1)).toEqual({ type: "done", finalText: "DENIED" });
  });

  it("interrupts the owned native process and does not mark an aborted turn done", async () => {
    const { client, root } = await fixture(); const session = await client.create({ title: "Cancel", cwd: root });
    const iterator = client.run(session.id, "CANCEL")[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("text_chunk");
    await client.abort(session.id);
    expect((await iterator.next()).value).toEqual({ type: "turn_aborted" });
    expect((await iterator.next()).done).toBe(true);
  });

  it("turns a process exit without terminal result into a visible failure", async () => {
    const { client, root } = await fixture(); const session = await client.create({ title: "Crash", cwd: root });
    const events = await collect(client.run(session.id, "CRASH"));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "RUNTIME_UNAVAILABLE" });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  it("retains the latest native revision without duplicating tool history", () => {
    const messages = decodeWorkBuddyHistory([
      { id: "message", type: "message", role: "assistant", content: [{ text: "old" }] },
      { id: "tool", type: "function_call", callId: "call", name: "Read", arguments: "{\"file\":\"README\"}" },
      { id: "message", type: "message", role: "assistant", content: [{ text: "new" }] },
      { id: "result", type: "function_call_result", callId: "call", output: { content: "native result" } },
    ]);
    expect(messages.map(message => message.content)).toEqual(["new", "", "native result"]);
    expect(messages[1].toolCalls?.[0].arguments).toEqual({ file: "README" });
  });

  it("keeps assistant text and distinct tool calls that share a native response ID", () => {
    const messages = decodeWorkBuddyHistory([
      { id: "shared", type: "message", role: "assistant", content: "Read both files first" },
      { id: "shared", type: "function_call", callId: "first", name: "Read", arguments: { file: "one" } },
      { id: "shared", type: "function_call", callId: "second", name: "Read", arguments: { file: "two" } },
      { id: "result-one", type: "function_call_result", callId: "first", output: "one" },
      { id: "result-two", type: "function_call_result", callId: "second", output: "two" },
      { id: "next-user", type: "message", role: "user", content: "Next question" },
    ]);
    expect(messages.map(message => message.content)).toEqual(["Read both files first", "", "", "one", "two", "Next question"]);
    expect(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? [])).toEqual(["first", "second"]);
  });

  it("updates each tool by call identity without changing its original position", () => {
    const messages = decodeWorkBuddyHistory([
      { id: "shared", type: "function_call", callId: "first", name: "Read", arguments: { file: "old" } },
      { id: "shared", type: "function_call", callId: "second", name: "Read", arguments: { file: "second" } },
      { id: "result", type: "function_call_result", callId: "first", output: "partial" },
      { id: "revised-call", type: "function_call", callId: "first", name: "Read", arguments: { file: "new" } },
      { id: "revised-result", type: "function_call_result", callId: "first", output: "complete" },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0].toolCalls?.[0]).toMatchObject({ id: "first", arguments: { file: "new" } });
    expect(messages[1].toolCalls?.[0].id).toBe("second");
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "first", content: "complete" });
  });

  it("preserves native causal order when queued input has an earlier creation timestamp", () => {
    const messages = decodeWorkBuddyHistory([
      { id: "call", type: "function_call", callId: "read", name: "Read", timestamp: 100 },
      { id: "result", type: "function_call_result", callId: "read", output: "finished", timestamp: 300 },
      { id: "queued", type: "message", role: "user", content: "Queued question", timestamp: 200 },
      { id: "reply", type: "message", role: "assistant", content: "Queued answer", timestamp: 400 },
    ]);
    expect(messages.map(message => message.content)).toEqual(["", "finished", "Queued question", "Queued answer"]);
  });

  it("does not resume a session with a live native writer", async () => {
    const { root, client } = await fixture();
    await mkdir(join(root, "projects", "existing"), { recursive: true });
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "projects", "existing", "occupied.jsonl"), JSON.stringify({ type: "message", role: "user", cwd: root, timestamp: Date.now(), content: "existing" }) + "\n");
    await writeFile(join(root, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "occupied" }));
    await expect(collect(client.run("occupied", "do not send"))).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
  });
});

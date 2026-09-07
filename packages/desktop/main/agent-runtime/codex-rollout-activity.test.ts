import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexRolloutActivityReader,
  codexRolloutActivityFromLine,
  readCodexRolloutFinalizingAnswer,
} from "./codex-rollout-activity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

function event(type: string): string {
  return JSON.stringify({ type: "event_msg", payload: { type } });
}

async function temporaryRollout(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-rollout-activity-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, content);
  return path;
}

describe("codexRolloutActivityFromLine", () => {
  it.each(["task_started", "turn_started"])("maps %s to running", (type) => {
    expect(codexRolloutActivityFromLine(event(type))).toBe("running");
  });

  it.each(["task_complete", "turn_complete", "turn_aborted"])("maps %s to idle", (type) => {
    expect(codexRolloutActivityFromLine(event(type))).toBe("idle");
  });

  it("ignores unrelated, malformed, and incomplete records", () => {
    expect(codexRolloutActivityFromLine('{"type":"event_msg","payload":{"type":"item_completed"}}')).toBe("unknown");
    expect(codexRolloutActivityFromLine('{"type":"event_msg"')).toBe("unknown");
    expect(codexRolloutActivityFromLine(" ")).toBe("unknown");
  });
});

describe("CodexRolloutActivityReader", () => {
  it("finds the newest lifecycle record across small reverse-read chunks", async () => {
    const path = await temporaryRollout([
      event("task_started"),
      JSON.stringify({ type: "event_msg", payload: { type: "item_completed", text: "x".repeat(80) } }),
      event("task_complete"),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      "",
    ].join("\n"));

    await expect(new CodexRolloutActivityReader(17).read(path)).resolves.toBe("idle");
  });

  it("reports an unfinished external turn as running despite malformed trailing JSON", async () => {
    const path = await temporaryRollout(`${event("task_started")}\n{"type":"event_msg"`);

    await expect(new CodexRolloutActivityReader(19).read(path)).resolves.toBe("running");
  });

  it("incrementally transitions from running to completed and aborted", async () => {
    const path = await temporaryRollout(`${event("task_started")}\n`);
    const reader = new CodexRolloutActivityReader(23);

    await expect(reader.read(path)).resolves.toBe("running");
    await appendFile(path, `${event("task_complete")}\n`);
    await expect(reader.read(path)).resolves.toBe("idle");
    await appendFile(path, `${event("task_started")}\n${event("turn_aborted")}\n`);
    await expect(reader.read(path)).resolves.toBe("idle");
  });

  it("retains an incomplete trailing record until the next append completes it", async () => {
    const path = await temporaryRollout(`${event("task_complete")}\n{"type":"event_msg","payload":{"type":"task_`);
    const reader = new CodexRolloutActivityReader(29);

    await expect(reader.read(path)).resolves.toBe("idle");
    await appendFile(path, 'started"}}\n');
    await expect(reader.read(path)).resolves.toBe("running");
  });

  it("skips oversized JSONL records without retaining them across reads", async () => {
    const oversizedRecord = JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", output: "x".repeat(512 * 1024) },
    });
    const path = await temporaryRollout(`${event("task_started")}\n${oversizedRecord}`);
    const reader = new CodexRolloutActivityReader(4093);

    await expect(reader.read(path)).resolves.toBe("running");
    await appendFile(path, `\n${event("task_complete")}\n`);
    await expect(reader.read(path)).resolves.toBe("idle");
  });

  it("resets cached activity after truncation", async () => {
    const path = await temporaryRollout(`${event("task_started")}\n${JSON.stringify({ padding: "x".repeat(100) })}\n`);
    const reader = new CodexRolloutActivityReader(31);

    await expect(reader.read(path)).resolves.toBe("running");
    await writeFile(path, `${event("task_complete")}\n`);
    await expect(reader.read(path)).resolves.toBe("idle");
  });

  it("resets cached activity after replacement and returns unknown for missing files", async () => {
    const path = await temporaryRollout(`${event("task_started")}\n`);
    const reader = new CodexRolloutActivityReader(37);

    await expect(reader.read(path)).resolves.toBe("running");
    await rm(path);
    await writeFile(path, `${event("task_complete")}\n`);
    await expect(reader.read(path)).resolves.toBe("idle");
    await rm(path);
    await expect(reader.read(path)).resolves.toBe("unknown");
  });
});

describe("readCodexRolloutFinalizingAnswer", () => {
  const finalAnswer = (turnId = "turn-1", text = "durable final") => JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      id: "message-1",
      role: "assistant",
      content: [{ type: "output_text", text }],
      phase: "final_answer",
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });

  it("finds a durable final answer before task_complete arrives", async () => {
    const path = await temporaryRollout([
      event("task_started"),
      finalAnswer(),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      "",
    ].join("\n"));

    await expect(readCodexRolloutFinalizingAnswer(path)).resolves.toEqual({
      turnId: "turn-1",
      itemId: "message-1",
      text: "durable final",
    });
  });

  it("stops at terminal and newer-start boundaries", async () => {
    const completed = await temporaryRollout(`${event("task_started")}\n${finalAnswer()}\n${event("task_complete")}\n`);
    const restarted = await temporaryRollout(`${event("task_started")}\n${finalAnswer()}\n${event("task_started")}\n`);

    await expect(readCodexRolloutFinalizingAnswer(completed)).resolves.toBeNull();
    await expect(readCodexRolloutFinalizingAnswer(restarted)).resolves.toBeNull();
  });

  it("recognizes the item_completed AgentMessage shape", async () => {
    const path = await temporaryRollout(`${event("task_started")}\n${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-2",
        item: {
          type: "AgentMessage",
          id: "message-2",
          content: [{ type: "Text", text: "second final" }],
          phase: "final_answer",
        },
      },
    })}\n`);

    await expect(readCodexRolloutFinalizingAnswer(path)).resolves.toEqual({
      turnId: "turn-2",
      itemId: "message-2",
      text: "second final",
    });
  });
});

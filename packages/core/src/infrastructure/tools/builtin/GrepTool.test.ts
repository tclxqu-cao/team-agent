import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrepTool } from "./GrepTool.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "grep-tool-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "nested"));
  await Promise.all([
    writeFile(join(root, "nested", "queued-message-order.ts"), "export function reconcileDurableQueuedMessages() {}\n"),
    writeFile(join(root, "nested", "ChatView.tsx"), "const sendState = 'pending';\n"),
    writeFile(join(root, "nested", "legacy.js"), "const sendState = 'legacy';\n"),
    writeFile(join(root, "nested", "notes.txt"), "sendState\n"),
  ]);
  return root;
}

describe("GrepTool include filters", () => {
  it("matches the representative recursive TypeScript wildcard", async () => {
    const root = await fixture();
    const result = await new GrepTool().execute({
      pattern: "reconcileDurableQueuedMessages|sendState",
      path: root,
      include: "*.ts*",
    }, { workingDirectory: root, sessionId: "session-1" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("nested/queued-message-order.ts:1:");
    expect(result.content).toContain("nested/ChatView.tsx:1:");
    expect(result.content).not.toContain("legacy.js");
    expect(result.content).not.toContain("notes.txt");
  });

  it("preserves comma-separated extension filters", async () => {
    const root = await fixture();
    const result = await new GrepTool().execute({
      pattern: "reconcileDurableQueuedMessages|sendState",
      path: root,
      include: ".ts,.js",
    }, { workingDirectory: root, sessionId: "session-1" });

    expect(result.content).toContain("nested/queued-message-order.ts:1:");
    expect(result.content).toContain("nested/legacy.js:1:");
    expect(result.content).not.toContain("ChatView.tsx");
    expect(result.content).not.toContain("notes.txt");
  });

  it("keeps a nonmatching wildcard as a clean negative result", async () => {
    const root = await fixture();
    const result = await new GrepTool().execute({
      pattern: "sendState",
      path: root,
      include: "*.vue",
    }, { workingDirectory: root, sessionId: "session-1" });

    expect(result).toEqual({
      toolCallId: "",
      content: 'No matches found for "sendState"',
    });
  });
});

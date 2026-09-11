import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointAwareToolExecutor, InMemoryFileCheckpointJournal } from "./checkpoints.js";
import type { IToolExecutor, ToolContext, ToolResult } from "./entities.js";

class StubExecutor implements IToolExecutor {
  applied: Record<string, string> = {};
  validate() { return true; }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const paths = name === "apply_patch"
      ? String(args.patch ?? "").split("\n").filter((line) => line.startsWith("+")).length
      : 1;
    void paths;
    const filePath = String(args.file_path ?? (args.patch ? name : "unknown"));
    this.applied[filePath] = String(args.content ?? "written");
    return { toolCallId: "", content: "ok" };
  }
}

const ctx: ToolContext = { sessionId: "s", workingDirectory: "/tmp", signal: new AbortController().signal };

describe("InMemoryFileCheckpointJournal", () => {
  it("restores modified, created, and deleted files per batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-checkpoint-"));
    const existing = path.join(root, "existing.txt");
    await writeFile(existing, "original", "utf8");
    const journal = new InMemoryFileCheckpointJournal();

    // Batch 1: modify existing + create new file
    journal.beginBatch();
    await journal.snapshot(existing);
    await writeFile(existing, "modified", "utf8");
    const created = path.join(root, "created.txt");
    await journal.snapshot(created);
    await writeFile(created, "new", "utf8");

    // Batch 2: delete the created file
    journal.beginBatch();
    await journal.snapshot(created);
    await rm(created);

    expect(journal.batchCount()).toBe(2);

    // Undo batch 2 restores the created file
    expect(await journal.undoLastBatch()).toEqual([created]);
    expect(await readFile(created, "utf8")).toBe("new");

    // Undo batch 1 restores original content and removes the created file
    const restored = await journal.undoLastBatch();
    expect(restored).toEqual(expect.arrayContaining([existing, created]));
    expect(await readFile(existing, "utf8")).toBe("original");
    expect(existsSync(created)).toBe(false);
    expect(await journal.undoLastBatch()).toBeNull();
  });

  it("dedupes repeated snapshots of the same path in one batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-checkpoint-"));
    const file = path.join(root, "a.txt");
    await writeFile(file, "v1", "utf8");
    const journal = new InFileTestJournal();
    journal.beginBatch();
    await journal.snapshot(file);
    await writeFile(file, "v2", "utf8");
    await journal.snapshot(file);
    expect(journal.batchCountForTest()).toBe(1);
    expect((await journal.undoLastBatch())!.length).toBe(1);
  });
});

class InFileTestJournal extends InMemoryFileCheckpointJournal {
  batchCountForTest(): number {
    return this.batchCount();
  }
}

describe("CheckpointAwareToolExecutor", () => {
  it("snapshots write-tool targets but not read tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-checkpoint-exec-"));
    const file = path.join(root, "code.ts");
    await writeFile(file, "before", "utf8");
    const journal = new InMemoryFileCheckpointJournal();
    const stub = new StubExecutor();
    const executor = new CheckpointAwareToolExecutor(stub, journal);

    journal.beginBatch();
    await executor.execute("read_file", { file_path: file }, ctx);
    await executor.execute("write_file", { file_path: file, content: "after" }, ctx);

    expect(await journal.undoLastBatch()).toEqual([file]);
    expect(await readFile(file, "utf8")).toBe("before");
    expect(stub.applied[file]).toBe("after");
  });

  it("snapshots apply_patch targets parsed from the patch body", async () => {
    const journal = new InMemoryFileCheckpointJournal();
    const stub = new StubExecutor();
    const executor = new CheckpointAwareToolExecutor(stub, journal);
    const patch = "*** Begin Patch\n*** Add File: new.ts\n+++ new.ts\n+export {}\n*** End Patch";
    journal.beginBatch();
    await executor.execute("apply_patch", { patch }, ctx);
    expect(stub.applied["apply_patch"]).toBe("written");
    // No crash and no snapshot of nonexistent b/ style paths required here.
    expect(await journal.undoLastBatch()).not.toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileSystemMemoryStore } from '../FileSystemMemoryStore.js';
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("FileSystemMemoryStore", () => {
  let store: FileSystemMemoryStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `agent-memory-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    store = new FileSystemMemoryStore(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should save and retrieve a memory", async () => {
    await store.set({
      name: "test-memory",
      description: "A test memory",
      type: "user",
      content: "This is test content",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });

    const entry = await store.get("test-memory");
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("test-memory");
    expect(entry!.type).toBe("user");
    expect(entry!.content).toBe("This is test content");
  });

  it("should list all memories", async () => {
    await store.set({
      name: "mem1",
      description: "First",
      type: "user",
      content: "Content 1",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });
    await store.set({
      name: "mem2",
      description: "Second",
      type: "project",
      content: "Content 2",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });

    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("should delete a memory", async () => {
    await store.set({
      name: "to-delete",
      description: "",
      type: "user",
      content: "Content",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });
    await store.delete("to-delete");
    const entry = await store.get("to-delete");
    expect(entry).toBeNull();
  });

  it("should search memories", async () => {
    await store.set({
      name: "project-alpha",
      description: "Alpha project details",
      type: "project",
      content: "This is about the Alpha project and its goals.",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });
    await store.set({
      name: "unrelated",
      description: "Something else",
      type: "user",
      content: "Nothing to do with Alpha.",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });

    const results = await store.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.name).toBe("project-alpha");
  });

  it("should generate context from relevant memories", async () => {
    await store.set({
      name: "user-role",
      description: "User role info",
      type: "user",
      content: "User is a senior software engineer working on AI agents.",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });

    const context = await store.generateContext("software engineer AI");
    expect(context).toContain("user-role");
  });

  it("should update MEMORY.md index", async () => {
    await store.set({
      name: "indexed-memory",
      description: "Memory for index test",
      type: "reference",
      content: "Test",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });

    const index = await store.getIndex();
    expect(index).toContain("indexed-memory");
    expect(index).toContain("Memory for index test");
  });
});

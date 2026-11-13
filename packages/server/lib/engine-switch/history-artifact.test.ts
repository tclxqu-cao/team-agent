import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { materializeEngineHistory } from "./history-artifact";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("keeps full long text and readable image files outside the prompt budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "engine-artifact-")); roots.push(root);
  vi.stubEnv("AGENT_NATIVE_RUNTIME_DIR", root);
  const text = "a".repeat(10_000) + "TAIL";
  const path = await materializeEngineHistory({ id: "handoff-1", workStateText: "todo pending", messages: [
    { role: "user", historyId: "a:0", content: text, images: ["data:image/png;base64,aGVsbG8="] },
  ] });
  const artifact = JSON.parse(await readFile(path, "utf8"));
  expect(artifact.items[0].content).toBe(text);
  expect(await readFile(artifact.items[0].imageFiles[0], "utf8")).toBe("hello");
  expect(artifact.workState).toBe("todo pending");
});

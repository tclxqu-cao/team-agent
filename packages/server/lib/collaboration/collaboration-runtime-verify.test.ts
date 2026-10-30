import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerCollaborationRuntime } from "./runtime";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tempCwd = () => {
  const dir = mkdtempSync(join(tmpdir(), "collab-verify-e2e-"));
  dirs.push(dir);
  return dir;
};

/** 真实 verify 实现（spawn /bin/sh）：成功、失败、中止与 cwd 语义。 */
describe("ServerCollaborationRuntime.verify 端到端", () => {
  const runtime = new ServerCollaborationRuntime();

  it("验收命令成功时返回 ok=true 与标准输出", async () => {
    const result = await runtime.verify(
      tempCwd(),
      "echo hello-verify",
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello-verify");
  });

  it("非零退出判失败，stdout 与 stderr 都进入输出", async () => {
    const result = await runtime.verify(
      tempCwd(),
      "echo bad-news >&2; exit 3",
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("bad-news");
  });

  it("在任务工作目录里执行，能检查目录内产物", async () => {
    const dir = tempCwd();
    const missing = await runtime.verify(
      dir,
      "test -f marker.txt && echo found",
      new AbortController().signal,
    );
    expect(missing.ok).toBe(false);
    writeFileSync(join(dir, "marker.txt"), "x");
    const present = await runtime.verify(
      dir,
      "test -f marker.txt && echo found",
      new AbortController().signal,
    );
    expect(present.ok).toBe(true);
    expect(present.output).toContain("found");
  });

  it("协作中止时立即杀掉验收进程并判失败", async () => {
    const controller = new AbortController();
    const pending = runtime.verify(tempCwd(), "sleep 5", controller.signal);
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

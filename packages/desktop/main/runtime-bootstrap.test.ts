import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DesktopRuntimeBootstrap } from "./runtime-bootstrap";

describe("desktop first-launch runtime preparation", () => {
  it("coalesces installs, reports worker progress, and permits a retry after failure", async () => {
    const children: Array<EventEmitter & { stdout: PassThrough }> = [];
    const spawn = vi.fn((_executable: string, _args: readonly string[], _options: unknown) => { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() }); children.push(child); return child; });
    const bootstrap = new DesktopRuntimeBootstrap(true, "/Applications/AgentRoam/Resources", "/electron", spawn as never);
    const first = bootstrap.prepare(); expect(bootstrap.prepare()).toBe(first);
    expect(spawn.mock.calls[0][1]).toEqual(["/Applications/AgentRoam/Resources/bootstrap/runtime-bootstrap.mjs"]);
    children[0].stdout.write('{"message":"正在检查终端…"}\n');
    expect(bootstrap.status().message).toBe("正在检查终端…");
    children[0].emit("exit", 1); expect((await first).phase).toBe("error");
    const retry = bootstrap.prepare(); children[1].emit("exit", 0);
    expect((await retry).phase).toBe("ready"); expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("leaves developer services alone", async () => {
    const spawn = vi.fn();
    expect((await new DesktopRuntimeBootstrap(false, "/resources", "/electron", spawn).prepare()).phase).toBe("idle");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("reports incompatible downloads without suggesting a network retry or leaking child errors", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    const spawn = vi.fn(() => child);
    const bootstrap = new DesktopRuntimeBootstrap(true, "/resources", "/electron", spawn as never);
    const pending = bootstrap.prepare();
    child.stdout.write('{"error":"runtime-incompatible"}\n');
    child.stdout.write('{"error":"secret-child-output"}\n');
    child.emit("exit", 1);
    expect(await pending).toEqual({ phase: "error", message: "当前安装包与运行组件版本不兼容，请下载配套的新版本。" });
  });
});

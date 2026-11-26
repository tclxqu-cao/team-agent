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
    const bootstrap = new DesktopRuntimeBootstrap(false, "/resources", "/electron", spawn);
    expect((await bootstrap.prepare()).phase).toBe("idle");
    await bootstrap.prepareRemoteComponent("screen");
    expect(spawn).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("coalesces component preparation and waits for it before a permission request", async () => {
    const children: EventEmitter[] = [];
    const spawn = vi.fn((_executable: string, _args: readonly string[]) => {
      const child = new EventEmitter();
      children.push(child);
      return child;
    });
    const bootstrap = new DesktopRuntimeBootstrap(true, "/resources", "/electron", spawn as never);
    const failed = bootstrap.prepareRemoteComponent();
    children[0].emit("exit", 1);
    await expect(failed).rejects.toThrow("远控组件更新未完成");
    const initial = bootstrap.prepareRemoteComponent();
    const recheck = bootstrap.prepareRemoteComponent();
    const screen = bootstrap.prepareRemoteComponent("screen");
    expect(children).toHaveLength(2);
    children[1].emit("exit", 0);
    await Promise.all([initial, recheck]);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2].emit("exit", 0);
    await screen;
    await bootstrap.prepareRemoteComponent();
    expect(spawn.mock.calls.map(call => call[1])).toEqual([
      ["/resources/bootstrap/runtime-bootstrap.mjs", "--remote-component"],
      ["/resources/bootstrap/runtime-bootstrap.mjs", "--remote-component"],
      ["/resources/bootstrap/runtime-bootstrap.mjs", "--remote-component", "screen"],
    ]);
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

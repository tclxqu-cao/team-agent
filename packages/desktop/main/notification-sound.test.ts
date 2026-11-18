import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: exec }));
import { createDesktopNotificationSound, notificationSoundDirectory } from "./notification-sound";
import { notificationPresentation, type NotificationSoundIntent } from "../shared/notification-presentation";

const sounds = fileURLToPath(new URL("../assets/notification-sounds/", import.meta.url));
const roots: string[] = [];
beforeEach(() => exec.mockReset());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bundled desktop notification audio", () => {
  it("does not overlap sounds from a notification batch and permits the next cue", () => {
    const beep = vi.fn(), warn = vi.fn();
    const play = createDesktopNotificationSound(beep, warn, "darwin", sounds);
    play(); play();
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith("/usr/bin/afplay", ["-v", "0.6", join(sounds, "completion.wav")], { timeout: 5000 }, expect.any(Function));
    exec.mock.calls[0][3](null);
    play();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(beep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["completion", "完成", "completion.wav"], ["approval", "确认", "approval.wav"],
    ["todo_reminder", "待办提醒", "reminder.wav"], ["todo_execution", "定时待办执行完成", "scheduled.wav"],
    ["todo_execution", "定时待办需要核实", "attention.wav"], ["todo_execution", "定时待办错过执行", "attention.wav"],
    ["todo_execution", "定时待办执行未完成", "error.wav"],
  ] as const)("plays the matching packaged cue for %s / %s", (kind, title, filename) => {
    createDesktopNotificationSound(vi.fn(), vi.fn(), "darwin", sounds)({ kind, title });
    expect(exec.mock.calls[0][1][2]).toBe(join(sounds, filename));
    const wav = readFileSync(join(sounds, filename));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBeGreaterThan(10000);
    expect(wav.length).toBeLessThan(90000);
  });

  it("loads packaged sounds outside app.asar using the actual desktop resource rule", () => {
    const root = mkdtempSync(join(tmpdir(), "notification-resources-")); roots.push(root);
    const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    const rule = config.match(/from: assets\/notification-sounds\s+to: ([^\s]+)/);
    expect(rule?.[1]).toBe("notification-sounds");
    expect(config).toContain("dist/shared/**/*");
    const resources = join(root, "Resources"); mkdirSync(resources);
    cpSync(sounds, join(resources, rule![1]), { recursive: true });
    const resolved = notificationSoundDirectory(resources, "file:///installed/app.asar/dist/main/notification-sound.js");
    expect(resolved).toBe(join(resources, "notification-sounds"));
    createDesktopNotificationSound(vi.fn(), vi.fn(), "darwin", resolved)({ kind: "approval", title: "确认" });
    expect(exec.mock.calls[0][1][2]).toBe(join(resources, "notification-sounds/approval.wav"));
  });

  it("passes the Windows WAV path as data instead of executable PowerShell text", () => {
    createDesktopNotificationSound(vi.fn(), vi.fn(), "win32", sounds)({ kind: "todo_reminder", title: "提醒" });
    const [command, args, options] = exec.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args.join(" ")).not.toContain(sounds);
    expect(options.env.AGENTROAM_NOTIFICATION_SOUND).toBe(join(sounds, "reminder.wav"));
    expect(options.windowsHide).toBe(true);
  });

  it("reports missing resources and audio failures without blocking future cues", () => {
    const warn = vi.fn(), beep = vi.fn(), error = new Error("audio output unavailable");
    const missing = createDesktopNotificationSound(beep, warn, "darwin", join(sounds, "missing"));
    missing(); expect(beep).toHaveBeenCalledOnce(); expect(exec).not.toHaveBeenCalled();
    const play = createDesktopNotificationSound(beep, warn, "darwin", sounds);
    play(); exec.mock.calls[0][3](error); play();
    expect(warn).toHaveBeenCalledWith("desktop notification sound failed", error);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("uses the platform beep outside the supported desktop targets", () => {
    const beep = vi.fn();
    createDesktopNotificationSound(beep, vi.fn(), "linux", sounds)();
    expect(beep).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not infer a failure from arbitrary notification text", () => {
    const ordinary: NotificationSoundIntent = { kind: "completion", title: "检查执行未完成的处理逻辑" };
    expect(notificationPresentation(ordinary).type).toBe("completion");
    expect(notificationPresentation({ ...ordinary, kind: "todo_execution" }).type).toBe("todo_execution");
  });
});

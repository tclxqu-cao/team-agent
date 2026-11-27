import { describe, expect, it, vi } from "vitest";
import { resolveNativeCliCommand } from "./native-cli-command.js";

const home = "/home/test";
const nodeExecutable = "/private/node";
function fixture(files: string[], env: NodeJS.ProcessEnv = {}) {
  return { env, home, nodeExecutable, platform: "darwin" as const, fileExists: async (path: string) => files.includes(path) };
}

describe("native CLI command discovery", () => {
  it("discovers Qoder without requiring the desktop app or a shell", async () => {
    const command = await resolveNativeCliCommand("qoder", fixture(["/home/test/.local/bin/qodercli"]));
    expect(command).toEqual({ command: "/home/test/.local/bin/qodercli", args: ["--acp"], env: {} });
  });

  it("uses overrides as one executable path, including paths with spaces", async () => {
    const path = "/custom app/zcode.cjs";
    const command = await resolveNativeCliCommand("zcode", fixture([path], { AGENT_ZCODE_BIN: path }));
    expect(command.command).toBe(nodeExecutable);
    expect(command.args).toEqual([path, "app-server"]);
  });

  it("sets packaged ZCode provider paths only in the child environment", async () => {
    const script = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
    const builtin = "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json";
    const personal = "/home/test/.zcode/v2/provider_config.json";
    const env = { PATH: "/empty" };
    const command = await resolveNativeCliCommand("zcode", fixture([script, builtin, personal], env));
    expect(command).toMatchObject({ command: nodeExecutable, args: [script, "app-server"], env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal } });
    expect(env).toEqual({ PATH: "/empty" });
  });

  it("keeps explicit provider paths authoritative", async () => {
    const script = "/custom/zcode.cjs";
    const env = { AGENT_ZCODE_BIN: script, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/chosen/builtin.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/chosen/personal.json" };
    const command = await resolveNativeCliCommand("zcode", fixture([script, "/config/provider/zcode-builtin.json", "/home/test/.zcode/v2/provider_config.json"], env));
    expect(command.env).toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/chosen/builtin.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/chosen/personal.json" });
  });

  it("repairs only the WorkBuddy child bundle/config context", async () => {
    const script = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
    const env = { ACC_PRODUCT_CONFIG_V3: "stale inherited catalog" };
    const workBuddyDesktopConfig = vi.fn(async () => "/home/test/.workbuddy/cache/desktop.json");
    const command = await resolveNativeCliCommand("workbuddy", { ...fixture([script], env), workBuddyDesktopConfig });
    expect(command.command).toBe(nodeExecutable);
    expect(command.args?.[0]).toBe(script);
    expect(command.args).toContain("stream-json");
    expect(workBuddyDesktopConfig).toHaveBeenCalledWith({ configDir: "/home/test/.workbuddy", platform: "darwin" });
    expect(command.env).toEqual({ CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1", CODEBUDDY_CONFIG_DIR: "/home/test/.workbuddy", WORKBUDDY_CONFIG_DIR: "/home/test/.workbuddy", ACC_PRODUCT_CONFIG_PATH: "/home/test/.workbuddy/cache/desktop.json", ACC_PRODUCT_CONFIG_V3: "", ACC_PRODUCT_CONFIG_V2: "", ACC_PRODUCT_CONFIG: "" });
    expect(env.ACC_PRODUCT_CONFIG_V3).toBe("stale inherited catalog");
  });

  it("does not advertise the bundled WorkBuddy bootstrap models when desktop configuration is unavailable", async () => {
    const script = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
    await expect(resolveNativeCliCommand("workbuddy", { ...fixture([script]), workBuddyDesktopConfig: async () => null }))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("WorkBuddy desktop") });
  });

  it("uses the same explicit WorkBuddy directory for desktop configuration and native sessions", async () => {
    const script = "/custom/codebuddy";
    const workBuddyDesktopConfig = vi.fn(async () => "/chosen/workbuddy/cache/desktop.json");
    const command = await resolveNativeCliCommand("workbuddy", {
      ...fixture([script], { AGENT_WORKBUDDY_BIN: script, WORKBUDDY_CONFIG_DIR: "/chosen/workbuddy", CODEBUDDY_CONFIG_DIR: "/unrelated/codebuddy" }),
      workBuddyDesktopConfig,
    });
    expect(workBuddyDesktopConfig).toHaveBeenCalledWith({ configDir: "/chosen/workbuddy", platform: "darwin" });
    expect(command.env).toMatchObject({ CODEBUDDY_CONFIG_DIR: "/chosen/workbuddy", WORKBUDDY_CONFIG_DIR: "/chosen/workbuddy" });
  });

  it("supports Windows packaged scripts through Node, not a shell command string", async () => {
    const script = "C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
    const command = await resolveNativeCliCommand("zcode", { ...fixture([script]), platform: "win32", home: "C:\\Users\\test", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } });
    expect(command.command).toBe(nodeExecutable);
    expect(command.args).toEqual([script, "app-server"]);
  });

  it("uses Linux PATH entrypoints without assuming macOS bundle paths", async () => {
    const command = await resolveNativeCliCommand("zcode", { ...fixture(["/bin/zcode"], { PATH: "/usr/bin:/bin" }), platform: "linux" });
    expect(command.command).toBe("/bin/zcode");
  });

  it("does not silently fall back from an invalid explicit override", async () => {
    await expect(resolveNativeCliCommand("qoder", fixture(["/bin/qodercli"], { PATH: "/bin", AGENT_QODER_BIN: "/missing" }))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(resolveNativeCliCommand("workbuddy", fixture([]))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

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

  describe("native CLI discovery on Windows", () => {
    const home = "C:\\Users\\Test User";
    const localAppData = "D:\\Profiles\\Test User\\Local";
    const appData = "D:\\Profiles\\Test User\\Roaming";
    const nativeExecutable = `${localAppData}\\qodercli\\qodercli.exe`;
    const npmDir = `${appData}\\npm`;
    const npmEntrypoint = `${npmDir}\\node_modules\\@qoder-ai\\qodercli\\bundle\\qodercli.js`;
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const windowsFixture = (files: string[], env: NodeJS.ProcessEnv = {}) => ({
      platform: "win32" as const,
      home,
      env: { LOCALAPPDATA: localAppData, APPDATA: appData, ...env },
      nodeExecutable: node,
      fileExists: async (path: string) => files.includes(path),
    });

    it("discovers the standalone CLI when the service PATH omits the install directory", async () => {
      await expect(resolveNativeCliCommand("qoder", windowsFixture([nativeExecutable, npmEntrypoint])))
        .resolves.toEqual({ command: nativeExecutable, args: ["--acp"], env: {} });
    });

    it("discovers the npm entrypoint directly even when PATH contains only npm shims", async () => {
      const files = [`${npmDir}\\qodercli`, `${npmDir}\\qodercli.cmd`, npmEntrypoint];
      await expect(resolveNativeCliCommand("qoder", windowsFixture(files, { Path: npmDir })))
        .resolves.toEqual({ command: node, args: [npmEntrypoint, "--acp"], env: {} });
    });

    it("honors a native CLI on PATH and skips earlier extensionless shims", async () => {
      const pathExecutable = "C:\\Qoder Tools\\qodercli.exe";
      const files = [`${npmDir}\\qodercli`, pathExecutable, nativeExecutable];
      await expect(resolveNativeCliCommand("qoder", windowsFixture(files, { Path: `${npmDir};C:\\Qoder Tools` })))
        .resolves.toEqual({ command: pathExecutable, args: ["--acp"], env: {} });
    });

    it("finds the installer-selected version even without an executable on PATH", async () => {
      const installDir = `${home}\\.qoder\\bin\\qodercli`;
      const executable = `${installDir}\\qodercli-1.1.96.exe`;
      const readTextFile = vi.fn(async () => "1.1.96\r\n");
      await expect(resolveNativeCliCommand("qoder", { ...windowsFixture([executable]), readTextFile }))
        .resolves.toEqual({ command: executable, args: ["--acp"], env: {} });
      expect(readTextFile).toHaveBeenCalledWith(`${installDir}\\version.txt`);
    });

    it.each([
      ["grok", `${home}\\.grok\\bin\\grok.exe`, ["--no-auto-update", "agent", "stdio"]],
      ["agy", `${localAppData}\\agy\\bin\\agy.exe`, ["acp"]],
      ["claude-code", `${home}\\.local\\bin\\claude.exe`, []],
    ] as const)("discovers the %s standalone executable outside PATH", async (agent, executable, args) => {
      await expect(resolveNativeCliCommand(agent, windowsFixture([executable])))
        .resolves.toEqual({ command: executable, args, env: {} });
    });

    it("honors the Grok installer's custom bin directory", async () => {
      const executable = "D:\\Grok Tools\\grok.exe";
      await expect(resolveNativeCliCommand("grok", windowsFixture([executable], { GROK_BIN_DIR: "D:\\Grok Tools" })))
        .resolves.toMatchObject({ command: executable });
    });

    it("finds WorkBuddy's desktop executable without sending the PE file to Node", async () => {
      const executable = `${localAppData}\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy.exe`;
      await expect(resolveNativeCliCommand("workbuddy", windowsFixture([executable])))
        .resolves.toMatchObject({ command: executable, args: expect.arrayContaining(["stream-json"]) });
    });

    it("launches CodeBuddy native or npm installations through the existing WorkBuddy protocol", async () => {
      const executable = `${localAppData}\\codebuddy\\bin\\codebuddy.exe`;
      const shim = `${npmDir}\\codebuddy`;
      const entry = `${npmDir}\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy`;
      const env = { Path: `"${npmDir}"` };
      await expect(resolveNativeCliCommand("workbuddy", windowsFixture([executable, shim, entry], env)))
        .resolves.toMatchObject({ command: executable });
      const npm = await resolveNativeCliCommand("workbuddy", windowsFixture([shim, entry], env));
      expect(npm.command).toBe(node);
      expect(npm.args?.slice(0, 2)).toEqual([entry, "--print"]);
      expect(npm.env?.WORKBUDDY_CONFIG_DIR).toBe(`${home}\\.workbuddy`);
    });

    it("finds the Claude Code npm binary behind the command shim", async () => {
      const executable = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
      await expect(resolveNativeCliCommand("claude-code", windowsFixture([executable, `${npmDir}\\claude.cmd`])))
        .resolves.toEqual({ command: executable, args: [], env: {} });
    });

    it.each(["D:\\Node Tools", "D:\\Node Tools\\node_modules\\.bin"])("starts the npm DeepSeek Harness CLI directly with Node from %s", async (directory) => {
      const shim = `${directory}\\dsh.cmd`;
      const entry = "D:\\Node Tools\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
      await expect(resolveNativeCliCommand("deepseek-harness", windowsFixture([shim, entry], { AGENT_DSH_EXECUTABLE: shim })))
        .resolves.toEqual({ command: node, args: [entry], env: {} });
    });

    it("starts the packaged DeepSeek Harness CLI without evaluating its batch file", async () => {
      const root = "D:\\Agents\\DeepSeek Harness";
      const command = `${root}\\DeepSeek Harness.exe`;
      const archive = `${root}\\resources\\app.asar`;
      const directory = `${root}\\resources\\runtime\\cli\\bin`;
      const files = [command, archive, `${directory}\\dsh.cmd`];
      await expect(resolveNativeCliCommand("deepseek-harness", windowsFixture(files, { Path: directory })))
        .resolves.toEqual({
          command,
          args: ["--expose-internals", `${archive}\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js`],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        });
    });

    it("rejects a standalone command shim without a supported package", async () => {
      const shim = `${npmDir}\\dsh.cmd`;
      await expect(resolveNativeCliCommand("deepseek-harness", windowsFixture([shim], { AGENT_DSH_EXECUTABLE: shim })))
        .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    });
  });

  it.each([
    ["grok", ["--no-auto-update", "agent", "stdio"]],
    ["agy", ["acp"]],
  ] as const)("discovers %s for ACP even when the desktop PATH omits ~/.local/bin", async (agent, args) => {
    const path = `/home/test/.local/bin/${agent}`;
    await expect(resolveNativeCliCommand(agent, fixture([path]))).resolves.toEqual({ command: path, args, env: {} });
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

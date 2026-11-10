import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import { loadQoderModelCatalog, parseQoderModelCatalog } from "./qoder-model-catalog.js";
import { RuntimeSessionError } from "./types.js";

vi.mock("./native-cli-command.js", () => ({ resolveNativeCliCommand: vi.fn() }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const nativeCatalog = `MODEL
Auto
Ultimate
Fast
Efficient
Sonus
Cantus
Qwen3.8-Max
free-model (magpie/group/free-model)
GPT-6 (Astra) · chat-gpt-omhk9 (magpie/chat-gpt-omhk9/gpt-6)
GPT-6.1 Sol · chat-gpt (magpie/ap-southeast-1-v5cjq-gptdy-17uso…)
GLM-5.3 · ZCode (magpie/zcode/GLM-5.3)
qoder/kmodel_latest (magpie/qoder/kmodel_latest)
`;

describe("Qoder model catalog parser", () => {
  it("parses the observed single-column catalog without guessing a truncated ID", () => {
    expect(parseQoderModelCatalog(nativeCatalog)).toEqual([
      ...["Auto", "Ultimate", "Fast", "Efficient", "Sonus", "Cantus", "Qwen3.8-Max"].map(id => ({ id, displayName: id })),
      { id: "magpie/group/free-model", displayName: "free-model" },
      { id: "magpie/chat-gpt-omhk9/gpt-6", displayName: "GPT-6 (Astra) · chat-gpt-omhk9" },
      { id: "magpie/zcode/GLM-5.3", displayName: "GLM-5.3 · ZCode" },
      { id: "magpie/qoder/kmodel_latest", displayName: "qoder/kmodel_latest" },
    ]);
  });

  it("normalizes ANSI formatting, CRLF and blank lines while preserving exact new preset IDs", () => {
    expect(parseQoderModelCatalog("\r\n\u001b[1mMODEL\u001b[0m\r\n\u001b[32mAuto\u001b[0m\r\nFuture-Preset_2.0\r\nQwen3.8-Max\r\n")).toEqual([
      { id: "Auto", displayName: "Auto" },
      { id: "Future-Preset_2.0", displayName: "Future-Preset_2.0" },
      { id: "Qwen3.8-Max", displayName: "Qwen3.8-Max" },
    ]);
  });

  it("splits the last parenthesized ID and treats its case and slash components as opaque", () => {
    expect(parseQoderModelCatalog("MODEL\nGPT-6 (Astra) (Preview) · Main (magpie/group/provider/Model_ID:2)\nProvider… (group/complete-id)\n")).toEqual([
      { id: "magpie/group/provider/Model_ID:2", displayName: "GPT-6 (Astra) (Preview) · Main" },
      { id: "group/complete-id", displayName: "Provider…" },
    ]);
  });

  it("deduplicates exact IDs only and keeps the first native label", () => {
    expect(parseQoderModelCatalog("MODEL\nAuto\nAuto\nDuplicate (Auto)\nFirst (group/model)\nSecond (group/model)\nDifferent (group/Model)\n")).toEqual([
      { id: "Auto", displayName: "Auto" },
      { id: "group/model", displayName: "First" },
      { id: "group/Model", displayName: "Different" },
    ]);
  });

  it("skips Unicode and ASCII ellipses in IDs, including truncated bare names", () => {
    expect(parseQoderModelCatalog("MODEL\nLong (magpie/region/model…)\nLonger (magpie/region/model...)\nAuto…\nFuture...\nStill visible (group/intact)\n")).toEqual([
      { id: "group/intact", displayName: "Still visible" },
    ]);
  });

  it("skips malformed rows rather than sending partial IDs", () => {
    expect(parseQoderModelCatalog("MODEL\nBroken (\nEmpty ()\nSpace (group/model id)\nNested (group/(model))\nMissing label)\n(group/model)\n(also/model)\nBad (group/model) suffix\nMODEL\nFuture-Preset\n")).toEqual([
      { id: "Future-Preset", displayName: "Future-Preset" },
    ]);
  });

  it.each([
    "", "Auto\nUltimate", "Models\nAuto", "MODEL ID\nAuto", "Please sign in to Qoder\nMODEL\nAuto",
    "Error: failed to list models", '{"models":[{"id":"Auto"}]}', "Usage: qodercli --list-models\nAuto",
    "MODEL\nPlease log in first\n", "MODEL\nAuto\nError: model discovery failed\n",
    "MODEL\nAuthentication required\n", "MODEL\nUnauthorized\n", "MODEL\nYou are not logged in\n",
    "MODEL\nWarning: use qodercli login\n",
  ])("does not turn login, error, hint or unsupported output into selectable models: %s", stdout => {
    expect(parseQoderModelCatalog(stdout)).toEqual([]);
  });
});

describe("Qoder model catalog loader", () => {
  it("resolves the Qoder entrypoint and enumerates models without ACP or shell execution", async () => {
    vi.mocked(resolveNativeCliCommand).mockResolvedValue({ command: "/native/qodercli", args: ["--acp"] });
    const execute = vi.fn(async () => ({ stdout: "MODEL\nAuto\n" }));
    await expect(loadQoderModelCatalog({ execute })).resolves.toEqual([{ id: "Auto", displayName: "Auto" }]);
    expect(resolveNativeCliCommand).toHaveBeenCalledOnce();
    expect(resolveNativeCliCommand).toHaveBeenCalledWith("qoder");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("/native/qodercli", ["--list-models"], expect.objectContaining({
      encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true,
    }));
  });

  it("preserves the Node entrypoint prefix, cwd and other args and merges child environment", async () => {
    vi.stubEnv("QODER_CATALOG_PARENT_TEST", "inherited");
    vi.stubEnv("QODER_CATALOG_OVERRIDE_TEST", "parent");
    const execute = vi.fn(async () => ({ stdout: "MODEL\nAuto\n" }));
    const args = ["/Applications/Native CLI/qoder.cjs", "--acp", "--config-dir", "/native/config with spaces"];
    const env = { QODER_CATALOG_OVERRIDE_TEST: "resolved", QODER_CATALOG_CHILD_TEST: "child" };
    const resolveCommand = vi.fn(async () => ({ command: "/native/node", args, env, cwd: "/native/workspace" }));
    await loadQoderModelCatalog({ resolveCommand, execute });
    expect(resolveCommand).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("/native/node", [
      "/Applications/Native CLI/qoder.cjs", "--config-dir", "/native/config with spaces", "--list-models",
    ], expect.objectContaining({
      cwd: "/native/workspace", shell: false, timeout: 15_000, maxBuffer: 1024 * 1024,
      env: expect.objectContaining({ QODER_CATALOG_PARENT_TEST: "inherited", QODER_CATALOG_OVERRIDE_TEST: "resolved", QODER_CATALOG_CHILD_TEST: "child" }),
    }));
    expect(args).toEqual(["/Applications/Native CLI/qoder.cjs", "--acp", "--config-dir", "/native/config with spaces"]);
    expect(env).toEqual({ QODER_CATALOG_OVERRIDE_TEST: "resolved", QODER_CATALOG_CHILD_TEST: "child" });
    expect(process.env.QODER_CATALOG_OVERRIDE_TEST).toBe("parent");
  });

  it("accepts an executable resolver without args and leaves empty output retryable", async () => {
    const execute = vi.fn(async () => ({ stdout: "" }));
    const resolveCommand = async () => ({ command: "/native/qodercli" });
    await expect(loadQoderModelCatalog({ resolveCommand, execute })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledWith("/native/qodercli", ["--list-models"], expect.any(Object));
  });

  it.each(["ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "EXIT_1"])("wraps %s without exposing process output or error details", async code => {
    const failure = Object.assign(new Error("sensitive process error"), { code, stdout: "sensitive stdout", stderr: "sensitive stderr" });
    const execute = vi.fn(async (): Promise<{ stdout: string }> => { throw failure; });
    const error = await loadQoderModelCatalog({ resolveCommand: async () => ({ command: "/native/qodercli" }), execute }).catch(error => error);
    expect(error).toBeInstanceOf(RuntimeSessionError);
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "Unable to list Qoder models; check the native CLI installation and sign-in" });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain("sensitive");
    expect(error).not.toHaveProperty("cause");
  });

  it("wraps resolver failures before running a process", async () => {
    const execute = vi.fn();
    const resolveCommand = async () => { throw new Error("sensitive resolver detail"); };
    await expect(loadQoderModelCatalog({ resolveCommand, execute })).rejects.toMatchObject({
      name: "RuntimeSessionError", code: "RUNTIME_UNAVAILABLE", message: "Unable to list Qoder models; check the native CLI installation and sign-in",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

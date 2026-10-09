import { describe, expect, it, vi } from "vitest";
import { discoverCodexDesktopEndpoint } from "./codex-desktop-endpoint.js";

const desktop = "10 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const server = "11 10 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

function discover(processes: string, sockets = "") {
  const execute = vi.fn(async (command: string) => ({ stdout: command === "/bin/ps" ? processes : sockets }));
  return { execute, result: discoverCodexDesktopEndpoint({ platform: "darwin", environment: {}, execute }) };
}

describe("Codex Desktop endpoint discovery", () => {
  it("finds a local WebSocket listener on the official Desktop child", async () => {
    const { result, execute } = discover(`${desktop}\n${server} -c features.code_mode_host=true app-server --listen ws://127.0.0.1:4500 --analytics-default-enabled`, "tIPv4\nn127.0.0.1:4500\n");
    await expect(result).resolves.toEqual({ webSocketUrl: "ws://127.0.0.1:4500/" });
    expect(execute).toHaveBeenLastCalledWith(
      "/usr/sbin/lsof", ["-nP", "-a", "-p", "11", "-iTCP", "-sTCP:LISTEN", "-Ftn"],
      expect.objectContaining({ timeout: 1500 }),
    );
  });

  it("accepts Codex.app installed in a path containing spaces and wildcard binds", async () => {
    const { result } = discover("20 1 /Volumes/My Disk/Codex.app/Contents/MacOS/Codex\n21 20 /Volumes/My Disk/Codex.app/Contents/Resources/codex app-server --listen=ws://0.0.0.0:4501", "tIPv6\nn*:4501\n");
    await expect(result).resolves.toEqual({ webSocketUrl: "ws://localhost:4501/" });
  });

  it("does not mistake a declared port for an owned listener", async () => {
    const { result } = discover(`${desktop}\n${server} app-server --listen ws://localhost:4500`, "tIPv4\nn127.0.0.1:5500\n");
    await expect(result).resolves.toBeNull();
  });

  it("uses only the named Unix socket belonging to the Desktop child", async () => {
    const { result, execute } = discover(
      `${desktop}\n${server} app-server --listen unix://`,
      "tunix\nn->0x102030\ntunix\nn/private/tmp/Desktop Socket.sock type=STREAM\n",
    );
    await expect(result).resolves.toEqual({ webSocketUrl: "ws+unix://localhost/private/tmp/Desktop%20Socket.sock:/rpc" });
    expect(execute).toHaveBeenLastCalledWith(
      "/usr/sbin/lsof", ["-nP", "-a", "-p", "11", "-U", "-Ftn"],
      expect.objectContaining({ timeout: 1500 }),
    );
  });

  it("matches an explicitly named socket rather than another open socket", async () => {
    const { result } = discover(
      `${desktop}\n${server} app-server --listen unix:///tmp/Desktop Socket.sock -c plugins.enabled=true`,
      "tunix\nn/tmp/other.sock\ntunix\nn/tmp/Desktop Socket.sock type=STREAM\n",
    );
    await expect(result).resolves.toEqual({ webSocketUrl: "ws+unix://localhost/tmp/Desktop%20Socket.sock:/rpc" });
  });

  it.each([
    `${desktop}\n${server} app-server --analytics-default-enabled`,
    `${desktop}\n${server} app-server --stdio`,
    `${desktop}\n${server} app-server proxy --sock /tmp/shared.sock`,
    `${desktop}\n${server} app-server daemon start`,
    `${desktop}\n${server} app-server --listen unix:// --managed-daemon`,
    `${desktop}\n12 1 /Applications/ChatGPT.app/Contents/Resources/codex app-server --listen unix:// --managed-daemon`,
    `${desktop}\n12 99 /usr/local/bin/codex app-server --listen ws://localhost:4500`,
  ])("does not borrow stdio, proxy, daemon or unrelated backend: %s", async (processes) => {
    const { result, execute } = discover(processes, "tunix\nn/tmp/shared.sock\n");
    await expect(result).resolves.toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects anonymous Unix socketpairs as endpoints", async () => {
    await expect(discover(`${desktop}\n${server} app-server --listen unix://`, "tunix\nn->0x102030\n").result)
      .resolves.toBeNull();
  });

  it.each(["ws://192.0.2.1:4500", "ws://127.0.0.1:0"])("skips an unusable listen address %s", async (url) => {
    await expect(discover(`${desktop}\n${server} app-server --listen ${url}`).result).resolves.toBeNull();
  });

  it.each(["win32", "linux"] as const)("keeps shared/standalone available on %s", async (platform) => {
    const execute = vi.fn();
    await expect(discoverCodexDesktopEndpoint({ platform, environment: {}, execute })).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats failed process inspection as unavailable", async () => {
    await expect(discoverCodexDesktopEndpoint({
      platform: "darwin", environment: {}, execute: async () => { throw new Error("ps timed out"); },
    })).resolves.toBeNull();
  });

  it("treats a disappearing Unix listener as unavailable", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: `${desktop}\n${server} app-server --listen unix://` })
      .mockRejectedValueOnce(new Error("lsof: process exited"));
    await expect(discoverCodexDesktopEndpoint({ platform: "darwin", environment: {}, execute })).resolves.toBeNull();
  });

  it.each(["ws://localhost:4500/rpc", "ws+unix://localhost/tmp/Desktop%20Socket.sock:/rpc"])(
    "uses an explicit local Desktop endpoint without process inspection: %s", async (webSocketUrl) => {
      const execute = vi.fn();
      await expect(discoverCodexDesktopEndpoint({
        platform: "win32", environment: { AGENT_CODEX_DESKTOP_WS_URL: webSocketUrl }, execute,
      })).resolves.toEqual({ webSocketUrl });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["https://example.com/", "ws://example.com:4500", "ws://user:secret@localhost:4500", "ws+unix://localhost/tmp/socket"])(
    "fails an invalid override so the client can fall back: %s", async (webSocketUrl) => {
      await expect(discoverCodexDesktopEndpoint({ environment: { AGENT_CODEX_DESKTOP_WS_URL: webSocketUrl } }))
        .rejects.toThrow("Codex Desktop endpoint");
    },
  );
});

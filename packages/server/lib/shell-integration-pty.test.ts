import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pty from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalShellLaunch, TERMINAL_READY_MARKER } from "../shell-integration.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed zsh real PTY startup", () => {
  it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
    "waits for slow startup without displaying integration source and preserves history reporting",
    async () => {
      const root = temporaryDirectory("agentroam-shell-pty");
      const originalZdotdir = join(root, "user-zdotdir");
      const serverBaseDir = join(root, "server");
      mkdirSync(originalZdotdir, { recursive: true });
      writeFileSync(join(originalZdotdir, ".zshrc"), "sleep 0.5\nPS1='agentroam-test% '\n", { mode: 0o600 });

      const launch = createTerminalShellLaunch({
        shell: "/bin/zsh",
        serverBaseDir,
        homeDir: root,
        env: { ...process.env, ZDOTDIR: originalZdotdir },
      });
      const terminal = pty.spawn("/bin/zsh", launch.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: root,
        env: launch.env,
      });
      let output = "";
      const startedAt = Date.now();
      const subscription = terminal.onData((data) => { output += data; });

      const waitFor = async (predicate: () => boolean, timeoutMs = 4_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for PTY output: ${JSON.stringify(output)}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(output).not.toContain(TERMINAL_READY_MARKER);
        await waitFor(() => output.includes(TERMINAL_READY_MARKER));
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
        expect(output).not.toContain("function __ca_hist_preexec");
        expect(output).not.toContain("function __ca_hist_precmd");
        expect(output).not.toContain("precmd_functions=(__ca_hist_precmd");

        terminal.write("true\r");
        const encodedCommand = Buffer.from("true").toString("base64");
        await waitFor(() => output.includes(`]633;C;${encodedCommand};`) && output.includes(";0\x07"));
      } finally {
        subscription.dispose();
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1_000);
          terminal.onExit(() => { clearTimeout(timeout); resolve(); });
          try { terminal.kill(); } catch { clearTimeout(timeout); resolve(); }
        });
      }
    },
    10_000,
  );
});

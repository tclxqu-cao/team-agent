import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeTerminalReadyMarker,
  createTerminalShellLaunch,
  ensureManagedZshDir,
  TERMINAL_READY_MARKER,
} from "../shell-integration.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed zsh startup integration", () => {
  it("writes restricted startup files that preserve the history protocol", () => {
    const root = temporaryDirectory("agentroam-shell");
    const originalZdotdir = join(root, "user's-zdotdir");
    const managed = ensureManagedZshDir({
      serverBaseDir: join(root, "server"),
      homeDir: join(root, "home"),
      env: { ZDOTDIR: originalZdotdir },
    });

    expect(statSync(managed).mode & 0o777).toBe(0o700);
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
      expect(statSync(join(managed, name)).mode & 0o777).toBe(0o600);
    }

    const zshrc = readFileSync(join(managed, ".zshrc"), "utf8");
    const originalZshrc = join(originalZdotdir, ".zshrc").replaceAll("'", `'\\''`);
    expect(zshrc).toContain(`source '${originalZshrc}'`);
    expect(zshrc).toContain('function __ca_hist_precmd(){ local e=$?;');
    expect(zshrc).toContain("precmd_functions=(__ca_hist_precmd $precmd_functions)");
    expect(zshrc).toContain("preexec_functions=(__ca_hist_preexec $preexec_functions)");
    expect(zshrc).toContain(String.raw`printf '\033]633;C;%s;%s;%s\007' "$c" "$d" "$e"`);

    const zlogin = readFileSync(join(managed, ".zlogin"), "utf8");
    expect(zlogin.indexOf("source ")).toBeLessThan(zlogin.indexOf("clear"));
    expect(zlogin.indexOf("clear")).toBeLessThan(zlogin.indexOf("export ZDOTDIR="));
    expect(zlogin).toContain("printf '\\033]633;AgentRoamReady;1\\007'");
  });

  it("restores an originally unset ZDOTDIR and never sources its managed files", () => {
    const root = temporaryDirectory("agentroam-shell-unset");
    const managed = ensureManagedZshDir({ serverBaseDir: join(root, "server"), homeDir: join(root, "home"), env: {} });
    expect(readFileSync(join(managed, ".zlogin"), "utf8")).toContain("unset ZDOTDIR");

    const reused = ensureManagedZshDir({ serverBaseDir: join(root, "server"), homeDir: join(root, "home"), env: { ZDOTDIR: managed } });
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
      expect(readFileSync(join(reused, name), "utf8")).not.toContain(`source '${reused}/${name}'`);
    }
  });

  it("rebuilds an incomplete managed directory", () => {
    const root = temporaryDirectory("agentroam-shell-recovery");
    const options = { serverBaseDir: join(root, "server"), homeDir: join(root, "home"), env: {} };
    const managed = ensureManagedZshDir(options);
    unlinkSync(join(managed, ".zlogin"));

    expect(ensureManagedZshDir(options)).toBe(managed);
    expect(existsSync(join(managed, ".zlogin"))).toBe(true);
  });

  it("builds interactive zsh, PowerShell, and unsupported-shell launches", () => {
    const root = temporaryDirectory("agentroam-shell-launch");
    const zsh = createTerminalShellLaunch({ shell: "/bin/zsh", serverBaseDir: root, homeDir: root, env: {} });
    expect(zsh.args).toEqual(["-l"]);
    expect(zsh.env.ZDOTDIR).toContain("shell-integration/zsh-v1-");
    expect(zsh.waitsForReady).toBe(true);

    const powershell = createTerminalShellLaunch({ shell: "pwsh.exe", serverBaseDir: root, homeDir: root, env: {} });
    expect(powershell.args.slice(0, 3)).toEqual(["-NoLogo", "-NoExit", "-Command"]);
    expect(powershell.args[3]).toContain("AgentRoamReady;1");
    expect(powershell.waitsForReady).toBe(true);

    expect(createTerminalShellLaunch({ shell: "/bin/bash", serverBaseDir: root, homeDir: root, env: {} })).toMatchObject({
      args: ["-l"],
      waitsForReady: false,
    });
  });
});

describe("terminal Ready marker", () => {
  it("recognizes every possible two-chunk split", () => {
    for (let split = 1; split < TERMINAL_READY_MARKER.length; split++) {
      const first = consumeTerminalReadyMarker("", TERMINAL_READY_MARKER.slice(0, split));
      expect(first.ready).toBe(false);
      expect(consumeTerminalReadyMarker(first.tail, TERMINAL_READY_MARKER.slice(split)).ready).toBe(true);
    }
  });

  it("drops unrelated output while retaining a partial marker suffix", () => {
    expect(consumeTerminalReadyMarker("", "prompt output")).toEqual({ ready: false, tail: "" });
    expect(consumeTerminalReadyMarker("", `prompt output${TERMINAL_READY_MARKER.slice(0, 4)}`)).toEqual({
      ready: false,
      tail: TERMINAL_READY_MARKER.slice(0, 4),
    });
  });
});

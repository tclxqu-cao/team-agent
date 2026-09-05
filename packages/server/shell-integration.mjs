import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPowerShell } from "./shell-platform.mjs";

const ZSH_INTEGRATION_VERSION = "v1";

export const TERMINAL_READY_MARKER = "\x1b]633;AgentRoamReady;1\x07";

export const ZSH_HISTORY_HOOK = `function __ca_hist_preexec(){ __ca_hist_cmd="$1"; }; function __ca_hist_precmd(){ local e=$?; if [[ -n "\${__ca_hist_cmd+x}" ]]; then local c=$(printf '%s' "$__ca_hist_cmd"|base64|tr -d '\\n'); local d=$(printf '%s' "$PWD"|base64|tr -d '\\n'); printf '\\033]633;C;%s;%s;%s\\007' "$c" "$d" "$e"; unset __ca_hist_cmd; fi; }; precmd_functions=(__ca_hist_precmd $precmd_functions); preexec_functions=(__ca_hist_preexec $preexec_functions);`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sourceIfReadable(file, managedFile) {
  if (path.resolve(file) === path.resolve(managedFile)) return "";
  const quoted = shellQuote(file);
  return `[[ -r ${quoted} ]] && source ${quoted}`;
}

function writeStartupFile(directory, name, content) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${content.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function ensureManagedZshDir({ serverBaseDir, homeDir, env = process.env }) {
  const originalWasSet = typeof env.ZDOTDIR === "string" && env.ZDOTDIR.length > 0;
  const originalZdotdir = path.resolve(originalWasSet ? env.ZDOTDIR : homeDir);
  const identity = createHash("sha256")
    .update(`${ZSH_INTEGRATION_VERSION}\0${originalWasSet ? "set" : "unset"}\0${originalZdotdir}`)
    .digest("hex")
    .slice(0, 12);
  const integrationRoot = path.join(path.resolve(serverBaseDir), "shell-integration");
  const managedDir = path.join(integrationRoot, `zsh-${ZSH_INTEGRATION_VERSION}-${identity}`);

  if ([".zshenv", ".zprofile", ".zshrc", ".zlogin"].every((name) => fs.existsSync(path.join(managedDir, name)))) {
    return managedDir;
  }

  if (fs.existsSync(managedDir)) fs.rmSync(managedDir, { recursive: true, force: true });

  fs.mkdirSync(integrationRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(integrationRoot, 0o700);
  const temporaryDir = path.join(integrationRoot, `.zsh-${randomBytes(8).toString("hex")}`);
  fs.mkdirSync(temporaryDir, { mode: 0o700 });

  const restoreManaged = `export ZDOTDIR=${shellQuote(managedDir)}`;
  const restoreOriginal = originalWasSet
    ? `export ZDOTDIR=${shellQuote(originalZdotdir)}`
    : "unset ZDOTDIR";

  try {
    for (const name of [".zshenv", ".zprofile"]) {
      writeStartupFile(temporaryDir, name, [
        sourceIfReadable(path.join(originalZdotdir, name), path.join(managedDir, name)),
        restoreManaged,
      ]);
    }
    writeStartupFile(temporaryDir, ".zshrc", [
      sourceIfReadable(path.join(originalZdotdir, ".zshrc"), path.join(managedDir, ".zshrc")),
      restoreManaged,
      ZSH_HISTORY_HOOK,
    ]);
    writeStartupFile(temporaryDir, ".zlogin", [
      sourceIfReadable(path.join(originalZdotdir, ".zlogin"), path.join(managedDir, ".zlogin")),
      "clear",
      restoreOriginal,
      "printf '\\033]633;AgentRoamReady;1\\007'",
    ]);

    try {
      fs.renameSync(temporaryDir, managedDir);
    } catch (error) {
      if (!fs.existsSync(managedDir)) throw error;
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }

  return managedDir;
}

function buildPowerShellIntegration() {
  return `function global:prompt { $e=[char]27; $b=[char]7; $p=$PWD.Path -replace '\\\\','/'; $u=if($p.StartsWith('//')){'file:'+$p}else{'file:///'+$p}; Write-Host -NoNewline ($e + ']7;' + $u + $b); 'PS ' + $PWD.Path + '> ' }; Clear-Host; $e=[char]27; $b=[char]7; Write-Host -NoNewline ($e + ']633;AgentRoamReady;1' + $b)`;
}

export function createTerminalShellLaunch({ shell, command, serverBaseDir, homeDir, env = process.env }) {
  if (shell.endsWith("zsh")) {
    const zdotdir = ensureManagedZshDir({ serverBaseDir, homeDir, env });
    return {
      args: command ? ["-l", "-c", command] : ["-l"],
      env: { ...env, ZDOTDIR: zdotdir },
      waitsForReady: true,
    };
  }

  if (isPowerShell(shell)) {
    if (command) return { args: ["-NoLogo", "-Command", command], env: { ...env }, waitsForReady: false };
    return {
      args: ["-NoLogo", "-NoExit", "-Command", buildPowerShellIntegration()],
      env: { ...env },
      waitsForReady: true,
    };
  }

  return {
    args: command ? ["-l", "-c", command] : ["-l"],
    env: { ...env },
    waitsForReady: false,
  };
}

export function consumeTerminalReadyMarker(tail, data) {
  const combined = `${tail || ""}${data || ""}`;
  if (combined.includes(TERMINAL_READY_MARKER)) return { ready: true, tail: "" };
  const maxLength = Math.min(combined.length, TERMINAL_READY_MARKER.length - 1);
  for (let length = maxLength; length > 0; length--) {
    const suffix = combined.slice(-length);
    if (TERMINAL_READY_MARKER.startsWith(suffix)) return { ready: false, tail: suffix };
  }
  return { ready: false, tail: "" };
}

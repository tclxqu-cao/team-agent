import { existsSync } from "node:fs";
import path from "node:path";

export function selectDefaultShell(
  platform = process.platform,
  env = process.env,
  exists = existsSync,
) {
  if (platform !== "win32") return env.SHELL || "/bin/zsh";

  const pathValue = env.PATH || env.Path || "";
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    for (const directory of pathValue.split(";").filter(Boolean)) {
      const candidate = path.win32.resolve(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (systemRoot) {
    const powershell = path.win32.resolve(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    if (exists(powershell)) return powershell;
  }
  throw new Error("PowerShell is required: install pwsh.exe or enable Windows PowerShell");
}

export function isPowerShell(shell) {
  return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell);
}

export function decodeOsc7Path(value, platform = process.platform) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    if (platform === "win32") {
      if (url.hostname) return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`;
      return pathname.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
    }
    return pathname;
  } catch {
    return null;
  }
}

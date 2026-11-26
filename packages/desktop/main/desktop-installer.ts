import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DesktopEdition } from "@agent/core";

const exec = promisify(execFile);

interface InstallerOptions {
  platform: NodeJS.Platform;
  edition: DesktopEdition;
  executable: string;
  openPath(path: string): Promise<string>;
  quit(): void;
}

export async function installDesktopUpdate(path: string, version: string, options: InstallerOptions): Promise<string> {
  if (options.platform === "win32") {
    try {
      await launch(path, ["--updated", "/S", "--force-run"]);
    } catch (error) {
      // Elevation and Windows security prompts belong to the normal installer.
      if ((await options.openPath(path)) !== "") throw error;
      return "已打开安装程序，请按系统提示完成更新";
    }
  } else {
    const bundle = dirname(dirname(dirname(await realpath(options.executable))));
    const bundleId = options.edition === "desktop-lite" ? "com.agentroam.desktop.lite" : "com.agentroam.desktop";
    if (!bundle.endsWith(".app") || await bundleProperty(bundle, "CFBundleIdentifier") !== bundleId) {
      throw new Error("无法定位当前 AgentRoam 应用");
    }
    let staging: string;
    try {
      staging = await mkdtemp(join(dirname(bundle), ".agentroam-update-"));
    } catch (error) {
      if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if ((await options.openPath(path)) !== "") throw error;
      return "已打开安装包，请将新版应用拖入「应用程序」";
    }

    try {
      const volume = join(staging, "volume");
      const replacement = join(staging, "replacement.app");
      const appName = options.edition === "desktop-lite" ? "AgentRoam Lite.app" : "AgentRoam.app";
      await mkdir(volume);
      await exec("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", volume, path]);
      try {
        const source = join(volume, appName);
        if (!(await lstat(source)).isDirectory()) throw new Error("更新包中缺少 AgentRoam 应用");
        await exec("/usr/bin/ditto", [source, replacement]);
        const [identifier, installedVersion] = await Promise.all([
          bundleProperty(replacement, "CFBundleIdentifier"),
          bundleProperty(replacement, "CFBundleShortVersionString"),
        ]);
        if (identifier !== bundleId || installedVersion !== version) throw new Error("更新包的应用标识或版本不匹配");
        await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", replacement]);
      } finally {
        await exec("/usr/bin/hdiutil", ["detach", volume]);
      }
      await launch("/bin/sh", ["-c", REPLACE_APP, "agentroam-update", String(process.pid), bundle, staging]);
    } catch (error) {
      // A failed detach must never make recursive cleanup enter the volume.
      await rm(join(staging, "replacement.app"), { force: true, recursive: true }).catch(() => undefined);
      await rmdir(join(staging, "volume")).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
      throw error;
    }
  }
  options.quit();
  return "已启动安装，应用将重新打开";
}

async function bundleProperty(bundle: string, key: string): Promise<string> {
  const { stdout } = await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents", "Info.plist")]);
  return stdout.trim();
}

function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

// Wait for Electron's normal shutdown before replacing its files. The two
// bundles are staged on the same volume. Restore the original on move or open failure.
const REPLACE_APP = `
old_pid=$1
app=$2
staging=$3
backup="$staging/previous.app"
replacement="$staging/replacement.app"
for attempt in $(/usr/bin/jot 120); do
  kill -0 "$old_pid" 2>/dev/null || break
  /bin/sleep 1
done
if kill -0 "$old_pid" 2>/dev/null; then exit 1; fi
if ! /bin/mv "$app" "$backup"; then
  /usr/bin/open -n "$app"
  exit 1
fi
if ! /bin/mv "$replacement" "$app"; then
  /bin/mv "$backup" "$app" && /usr/bin/open -n "$app"
  exit 1
fi
if ! /usr/bin/open -n "$app"; then
  /bin/mv "$app" "$replacement" && /bin/mv "$backup" "$app" && /usr/bin/open -n "$app"
  exit 1
fi
/bin/rm -rf "$backup"
/bin/rmdir "$staging/volume" "$staging"
`;

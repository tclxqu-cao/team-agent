import { execFile, spawn } from "node:child_process";
import { extname, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { OpenDialogOptions } from "electron";

const run = promisify(execFile);

export type ArtifactOpenChoice = "default" | "browser" | "application";

export function artifactOpenChoices(preview: boolean): { label: string; choice: ArtifactOpenChoice }[] {
  return [
    { label: preview ? "在默认浏览器中预览" : "用默认应用打开", choice: "default" },
    ...(preview ? [{ label: "选择浏览器预览…", choice: "browser" as const }] : []),
    { label: "选择应用打开原文件…", choice: "application" },
  ];
}

function applicationType(platform: NodeJS.Platform) {
  if (platform === "darwin") return { extension: "app", defaultPath: "/Applications" };
  if (platform === "win32") return { extension: "exe", defaultPath: process.env.ProgramFiles };
  return { extension: "desktop", defaultPath: "/usr/share/applications" };
}

export function artifactApplicationPicker(browser: boolean, platform = process.platform): OpenDialogOptions {
  const { extension, defaultPath } = applicationType(platform);
  return {
    title: browser ? "选择预览浏览器" : "选择打开文件的应用",
    buttonLabel: browser ? "在此浏览器预览" : "使用此应用打开",
    defaultPath,
    properties: ["openFile"],
    filters: [{ name: "应用程序", extensions: [extension] }],
  };
}

export function artifactApplicationCommand(application: string, target: string, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(application) || extname(application).toLowerCase() !== `.${applicationType(platform).extension}`) {
    throw new Error("请选择有效的应用程序");
  }
  if (platform === "darwin") return { command: "/usr/bin/open", args: ["-a", application, target] };
  if (platform === "win32") return { command: application, args: [target] };
  return { command: "gio", args: ["launch", application, target] };
}

export async function launchArtifactApplication(application: string, target: string): Promise<void> {
  const { command, args } = artifactApplicationCommand(application, target);
  if (process.platform !== "win32") {
    await run(command, args);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

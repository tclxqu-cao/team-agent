import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskCompletionNotification, TaskNotificationPreferences } from "@agent/core";

const execFileAsync = promisify(execFile);

async function notifyMac(notification: TaskCompletionNotification, sound: boolean): Promise<void> {
  const script = sound
    ? 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "default"\nend run'
    : 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
  await execFileAsync("/usr/bin/osascript", ["-e", script, notification.title, notification.body]);
}

async function notifyWindows(notification: TaskCompletionNotification): Promise<void> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$n=New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon=[System.Drawing.SystemIcons]::Information",
    "$n.BalloonTipTitle=$args[0]",
    "$n.BalloonTipText=$args[1]",
    "$n.Visible=$true",
    "$n.ShowBalloonTip(5000)",
    "Start-Sleep -Milliseconds 5500",
    "$n.Dispose()",
  ].join(";");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, notification.title, notification.body]);
}

export async function notifyTuiTaskCompletion(
  notification: TaskCompletionNotification,
  preferences: TaskNotificationPreferences,
): Promise<boolean> {
  if (!preferences.completionEnabled) return false;
  try {
    if (process.platform === "darwin") await notifyMac(notification, preferences.soundEnabled);
    else if (process.platform === "win32") await notifyWindows(notification);
    else throw new Error("native notifications unsupported");
    return true;
  } catch {
    if (preferences.soundEnabled && process.stdout.isTTY) process.stdout.write("\u0007");
    return false;
  }
}

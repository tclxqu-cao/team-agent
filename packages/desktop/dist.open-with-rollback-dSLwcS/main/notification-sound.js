import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { notificationPresentation } from "../shared/notification-presentation.js";
export function notificationSoundDirectory(resourcesPath, moduleUrl = import.meta.url) {
    const packaged = resourcesPath ? join(resourcesPath, "notification-sounds") : undefined;
    return packaged && existsSync(packaged)
        ? packaged
        : fileURLToPath(new URL("../../assets/notification-sounds/", moduleUrl));
}
/** App audio remains audible when macOS suppresses notification alert sounds. */
export function createDesktopNotificationSound(beep, warn, platform = process.platform, soundsDirectory = notificationSoundDirectory(process.resourcesPath)) {
    let playing = false;
    return (notification = { kind: "completion", title: "" }) => {
        if (playing)
            return;
        if (platform !== "darwin" && platform !== "win32") {
            beep();
            return;
        }
        const sound = join(soundsDirectory, notificationPresentation(notification).sound);
        if (!existsSync(sound)) {
            warn("desktop notification sound resource missing", sound);
            beep();
            return;
        }
        playing = true;
        const done = (error) => {
            playing = false;
            if (error)
                warn("desktop notification sound failed", error);
        };
        if (platform === "darwin")
            execFile("/usr/bin/afplay", ["-v", "0.6", sound], { timeout: 5000 }, done);
        else
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                "$player = New-Object System.Media.SoundPlayer; $player.SoundLocation = [Environment]::GetEnvironmentVariable('AGENTROAM_NOTIFICATION_SOUND'); $player.PlaySync()"], { timeout: 5000, windowsHide: true, env: { ...process.env, AGENTROAM_NOTIFICATION_SOUND: sound } }, done);
    };
}
//# sourceMappingURL=notification-sound.js.map
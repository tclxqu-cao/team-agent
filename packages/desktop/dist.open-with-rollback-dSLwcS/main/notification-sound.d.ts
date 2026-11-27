import { type NotificationSoundIntent } from "../shared/notification-presentation.js";
export declare function notificationSoundDirectory(resourcesPath?: string, moduleUrl?: string): string;
/** App audio remains audible when macOS suppresses notification alert sounds. */
export declare function createDesktopNotificationSound(beep: () => void, warn: (message: string, error?: unknown) => void, platform?: NodeJS.Platform, soundsDirectory?: string): (notification?: NotificationSoundIntent) => void;
//# sourceMappingURL=notification-sound.d.ts.map
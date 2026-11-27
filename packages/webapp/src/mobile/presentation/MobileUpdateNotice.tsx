import { Capacitor } from "@capacitor/core";
import type { ReactNode } from "react";
import UpdateNotice from "../../../../desktop/renderer/components/UpdateNotice";
import { AndroidUpdateService } from "../infrastructure/android-update";
import { IosUpdateService } from "../infrastructure/ios-update";

const platform = Capacitor.getPlatform();
const androidUpdates = platform === "android" ? new AndroidUpdateService() : null;
const iosUpdates = platform === "ios" ? new IosUpdateService() : null;

export function MobileUpdateNotice({ children }: { children: ReactNode }) {
  if (androidUpdates) {
    return <UpdateNotice api={androidUpdates} product="AgentRoam Android" scope="android" hint="下载后按 Android 提示确认安装">{children}</UpdateNotice>;
  }
  if (iosUpdates) {
    return <UpdateNotice api={iosUpdates} product="AgentRoam iOS" scope="ios"
      hint="在 App Store 确认更新" installLabel="前往 App Store">{children}</UpdateNotice>;
  }
  return children;
}

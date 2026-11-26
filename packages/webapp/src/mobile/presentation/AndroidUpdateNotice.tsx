import { Capacitor } from "@capacitor/core";
import UpdateNotice from "../../../../desktop/renderer/components/UpdateNotice";
import { AndroidUpdateService } from "../infrastructure/android-update";

const updates = Capacitor.getPlatform() === "android" ? new AndroidUpdateService() : null;

export function AndroidUpdateNotice() {
  return updates && <UpdateNotice api={updates} product="AgentRoam Android" scope="android" hint="下载后按 Android 提示确认安装" />;
}

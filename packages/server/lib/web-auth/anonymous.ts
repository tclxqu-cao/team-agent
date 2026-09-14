import { SQLiteAnonymousWebStore } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";
import { webConsoleStore } from "./http";

export const WEB_ANON_USERNAME = "local";
export const WEB_ANON_DEVICE_ID = "browser";

export interface AnonymousPrincipal {
  userId: string;
  username: string;
  deviceId: string;
}

const anonymousWebStore = new SQLiteAnonymousWebStore(getServerBaseDir());
/** Legacy shared workspace owner, not an authentication mechanism. The gateway authorizes each device. */
export function anonymousPrincipal(): AnonymousPrincipal {
  const principal = anonymousWebStore.getOrCreatePrincipal();
  return {
    userId: principal.userId,
    username: WEB_ANON_USERNAME,
    deviceId: WEB_ANON_DEVICE_ID,
  };
}

export { webConsoleStore };

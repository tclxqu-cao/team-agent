import { SQLiteSessionViews, syncSessionViews as execute, type SessionView } from "@agent/core";
import { getServerBaseDir } from "./server-data-dir";

export function syncSessionViews(afterRevision: number, views: SessionView[], baseDir = getServerBaseDir()) {
  return execute(new SQLiteSessionViews(baseDir), { afterRevision, views }, Date.now());
}

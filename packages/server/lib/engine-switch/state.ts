import { getDatabase, SQLiteEngineSwitchRepository } from "@agent/core";
import { resolveNativeRuntimeDirectory } from "@agent/native-runtime";
import { getServerBaseDir } from "../server-data-dir";

let repository: SQLiteEngineSwitchRepository | undefined;

/** The detached broker and all gateways share one authoritative switch ledger. */
export function getEngineSwitchRepository(): SQLiteEngineSwitchRepository {
  if (!repository) {
    const destination = getDatabase(resolveNativeRuntimeDirectory()).db;
    const candidate = new SQLiteEngineSwitchRepository(destination);
    const legacy = getDatabase(getServerBaseDir()).db;
    if (legacy !== destination) candidate.importLegacy(new SQLiteEngineSwitchRepository(legacy));
    repository = candidate;
  }
  return repository;
}

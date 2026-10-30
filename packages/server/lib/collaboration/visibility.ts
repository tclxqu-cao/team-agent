import { SQLiteCollaborationRepository, SQLiteSupervisionRepository } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";

/** Internal member sessions remain accessible in the group, not duplicated in ordinary chat lists. */
export function collaborationSessionIds(): Set<string> {
  const ids = new SQLiteCollaborationRepository(
    getServerBaseDir(),
  ).memberSessionIds();
  for (const id of new SQLiteSupervisionRepository(getServerBaseDir()).internalSessionIds()) ids.add(id);
  return ids;
}

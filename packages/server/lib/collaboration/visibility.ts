import { SQLiteCollaborationRepository } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";

/** Internal member sessions remain accessible in the group, not duplicated in ordinary chat lists. */
export function collaborationSessionIds(): Set<string> {
  return new SQLiteCollaborationRepository(
    getServerBaseDir(),
  ).memberSessionIds();
}

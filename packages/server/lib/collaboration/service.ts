import {
  CollaborationService,
  SQLiteCollaborationRepository,
} from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";
import { ServerCollaborationRuntime } from "./runtime";

const shared = globalThis as typeof globalThis & {
  __collaboration?: CollaborationService;
};
export function collaborationService(): CollaborationService {
  if (!shared.__collaboration) {
    const service = new CollaborationService(
      new SQLiteCollaborationRepository(getServerBaseDir()),
      new ServerCollaborationRuntime(),
      undefined,
      (error) => console.error("Collaboration scheduler:", error),
    );
    shared.__collaboration = service;
    const timer = setInterval(() => {
      void service
        .tick()
        .catch((error) => console.error("Collaboration scheduler:", error));
    }, 1000);
    timer.unref();
    void service
      .tick()
      .catch((error) => console.error("Collaboration recovery:", error));
  }
  return shared.__collaboration;
}

import { SQLiteCollaborationRepository, SQLiteSupervisionRepository, SupervisionService } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";
import { ServerSupervisionRuntime } from "./runtime";

const shared = globalThis as typeof globalThis & { __supervisionService?: SupervisionService };
export function supervisionService(): SupervisionService {
  if (!shared.__supervisionService) {
    const groups = new SQLiteCollaborationRepository(getServerBaseDir());
    const repository = new SQLiteSupervisionRepository(getServerBaseDir());
    const service = new SupervisionService(repository, () => groups.listGroups(), new ServerSupervisionRuntime(repository), undefined, undefined, error => console.error("Supervision:", error));
    shared.__supervisionService = service;
    const timer = setInterval(() => { void service.tick().catch(error => console.error("Supervision scheduler:", error)); }, 1000);
    timer.unref();
    void service.tick().catch(error => console.error("Supervision recovery:", error));
  }
  return shared.__supervisionService;
}

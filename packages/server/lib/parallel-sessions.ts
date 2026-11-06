import { homedir } from "node:os";
import { HostPathPolicy, SQLiteParallelSessionStore, createParallelSessions, type CreateParallelSessionsInput } from "@agent/core";
import type { UnifiedSessionSummary } from "@agent/native-runtime";
import { agentHost } from "../app/api/agent-host";
import { webProjectService } from "../app/api/projects/project-http";
import { getNativeRuntimeService } from "./native-runtime-service";
import { getServerBaseDir } from "./server-data-dir";

function store() { return new SQLiteParallelSessionStore<UnifiedSessionSummary>(getServerBaseDir()); }

export function getParallelSessionGroup(sessionId: string) {
  return store().getForSession(sessionId);
}

export async function createParallelSessionGroup(input: CreateParallelSessionsInput) {
  const cwd = HostPathPolicy.fromEnvironment(process.env.AGENT_WEB_ROOTS, homedir()).assertDirectory(input.cwd);
  return createParallelSessions({ ...input, cwd }, {
    create: async (agentType, title, path): Promise<UnifiedSessionSummary> => {
      if (agentType !== "customer-agent") {
        // Project IDs belong to one runtime. cwd works even before this Agent has visited the directory.
        return getNativeRuntimeService().create({ agentType, title, cwd: path });
      }
      const project = await webProjectService.create(path);
      const session = await agentHost.createSession(title, project.id);
      return {
        id: session.id, agentType, nativeSessionId: session.id, title: session.title,
        cwd: path, projectId: project.id, created: session.created, updated: session.updated,
        status: "idle", occupancy: "available", sourceLabel: "Customer Agent",
        canResume: true, canDelete: true, messageQueueVersion: 1,
      };
    },
    remove: async id => {
      if (id.startsWith("runtime:")) await getNativeRuntimeService().delete(id);
      else await agentHost.getSessionStore().delete(id);
    },
    save: group => store().create(group),
  });
}

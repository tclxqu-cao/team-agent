import { homedir } from "node:os";
import {
  HostPathError,
  HostPathPolicy,
  SQLiteProjectStore,
} from "@agent/core";
import { getServerBaseDir } from "../../../lib/server-data-dir";
import {
  WebProjectError,
  WebProjectService,
} from "../../../lib/web-project-service";

// HTTP adapter composition: bind application ports to host infrastructure.
export const webProjectService = new WebProjectService(
  new SQLiteProjectStore(getServerBaseDir()),
  HostPathPolicy.fromEnvironment(process.env.AGENT_WEB_ROOTS, homedir()),
);

export function projectErrorResponse(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof WebProjectError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof HostPathError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }
  return {
    status: 500,
    body: {
      error: error instanceof Error ? error.message : "项目操作失败",
      code: "PROJECT_OPERATION_FAILED",
    },
  };
}

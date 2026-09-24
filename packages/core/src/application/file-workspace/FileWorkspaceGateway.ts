import type {
  FileWorkspaceEventMessage,
  FileWorkspaceMethod,
} from "../../domain/file-workspace/index.js";

export interface FileWorkspaceGateway {
  request<T>(
    method: FileWorkspaceMethod,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  subscribe(
    type: "fs:event",
    listener: (event: FileWorkspaceEventMessage) => void,
  ): () => void;
}

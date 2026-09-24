import type { FileWorkspaceGateway } from "../../../core/src/application/file-workspace/FileWorkspaceGateway";
import type {
  FileWorkspaceEventMessage,
  FileWorkspaceMethod,
} from "../../../core/src/domain/file-workspace/entities";

export interface ElectronFileWorkspaceApi {
  fileWorkspaceRequest<T = unknown>(
    method: FileWorkspaceMethod,
    params?: Record<string, unknown>,
  ): Promise<T>;
  onFileWorkspaceEvent(callback: (event: FileWorkspaceEventMessage) => void): () => void;
}

export function createElectronFileWorkspaceGateway(
  api: ElectronFileWorkspaceApi,
): FileWorkspaceGateway {
  return {
    request: <T,>(method: FileWorkspaceMethod, params?: Record<string, unknown>) => (
      api.fileWorkspaceRequest<T>(method, params)
    ),
    subscribe: (type, listener) => {
      if (type !== "fs:event") return () => {};
      return api.onFileWorkspaceEvent(listener);
    },
  };
}

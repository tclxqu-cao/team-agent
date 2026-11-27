import type { UpdateStatus } from "../../contracts/agent-api";
import type { HttpClient } from "./http-client";

export function createHttpUpdateApi(http: HttpClient) {
  return {
    getUpdateStatus: () => http.get<UpdateStatus>("/api/update/status", { timeoutMs: 5_000 }),
    checkForUpdate: () => http.post<UpdateStatus>("/api/update/check", {}, { timeoutMs: 5_000 }),
    installUpdate: () => http.post<UpdateStatus>("/api/update/install", {}, { timeoutMs: 5_000 }),
    onUpdateStatus: () => () => undefined,
  };
}

export type * from "../../shared/src/contracts/agent-api";

declare global {
  interface Window {
    clientLogApi?: { report: (payload: unknown) => Promise<{ ok: boolean }> };
  }
}

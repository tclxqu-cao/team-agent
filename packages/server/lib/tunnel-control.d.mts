import type { TunnelStatus } from "../../shared/src/contracts/tunnel-status";
export type { TunnelStatus } from "../../shared/src/contracts/tunnel-status";

export function createTunnelControlGateway(options: {
  desktop: { authenticate(req: unknown): boolean };
  parent?: any;
}): { handle(req: any, res: any): boolean; close(): void };

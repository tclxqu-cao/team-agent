export interface TunnelStatus {
  phase: "idle" | "connecting" | "ready" | "error" | "unsupported";
  mode: "local" | "lan" | "public";
  provider: "cloudflare" | "pinggy" | "custom" | "lan";
  accessUrl?: string;
  stage?: "connecting" | "checking";
  error?: string;
}
export function createTunnelControlGateway(options: {
  desktop: { authenticate(req: unknown): boolean };
  parent?: any;
}): { handle(req: any, res: any): boolean; close(): void };

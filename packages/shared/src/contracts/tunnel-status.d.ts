export interface TunnelStatus {
  phase: "idle" | "connecting" | "ready" | "error" | "unsupported";
  mode: "local" | "lan" | "public";
  provider: "cloudflare" | "pinggy" | "custom" | "self-hosted" | "lan";
  accessUrl?: string;
  stage?: "connecting" | "checking";
  error?: string;
}

export interface PairingRoute {
  id: string;
  kind: "self-hosted" | "cloudflare" | "lan" | "tailscale" | "vpn" | "headscale";
  address?: string;
  interfaceName?: string;
}

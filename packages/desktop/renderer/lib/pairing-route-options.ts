import type { PairingRoute } from "../../../shared/src/contracts/tunnel-status";

function isVpnAdapter(route: PairingRoute): boolean {
  return (route.kind === "lan" || route.kind === "vpn") &&
    /^(?:utun|tun|tap|wg|ppp)\d+$|wireguard|wintun|openvpn|\bvpn\b/i.test(route.interfaceName ?? "");
}

const methods: { label: string; matches(route: PairingRoute): boolean; optional?: boolean }[] = [
  { label: "自建 VPN", matches: (r: PairingRoute) => r.kind === "headscale" || isVpnAdapter(r) },
  { label: "局域网", matches: (r: PairingRoute) => r.kind === "lan" && !isVpnAdapter(r) },
  { label: "Tailscale", matches: (r: PairingRoute) => r.kind === "tailscale" },
  { label: "本机网络 IP", matches: (r: PairingRoute) => !!r.address && ["lan", "vpn", "tailscale"].includes(r.kind) },
  { label: "Cloudflare（公网）", matches: (r: PairingRoute) => r.kind === "cloudflare" },
  { label: "自建 HTTPS", matches: r => r.kind === "self-hosted", optional: true },
];

interface RouteOption {
  key: string;
  label: string;
  route?: PairingRoute;
}

export function pairingRouteOptions(routes: PairingRoute[], missing: string) {
  return methods.flatMap<RouteOption>(({ label, matches, optional }) => {
    const choices = routes.filter(matches);
    if (!choices.length) return optional ? [] : [{ key: label, label: `${label} · ${missing}` }];
    return choices.map(route => ({
      key: `${label}/${route.id}`,
      label: [label, route.kind === "headscale" && "Headscale", route.address, route.interfaceName].filter(Boolean).join(" · "),
      route,
    }));
  });
}

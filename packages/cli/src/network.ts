import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function findLanUrl(port: number, interfaces: InterfaceMap = networkInterfaces()): string | null {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const address = addresses.find(isPrivateIpv4) ?? addresses[0];
  return address ? `http://${address}:${port}` : null;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { createSocket } from "node:dgram";

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function findLanUrl(port: number, interfaces: InterfaceMap = networkInterfaces(), routedAddress?: string | null): string | null {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const address = routedAddress && addresses.includes(routedAddress) && isPrivateIpv4(routedAddress)
    ? routedAddress : addresses.find(isPreferredLanIpv4);
  return address ? `http://${address}:${port}` : null;
}

/** UDP connect selects the OS route without sending a packet to the destination. */
export async function findRoutedLanUrl(port: number): Promise<string | null> {
  const routedAddress = await new Promise<string | null>((done) => {
    const socket = createSocket("udp4");
    let settled = false;
    const finish = (address: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* A failed bind may leave no socket to close. */ }
      done(address);
    };
    const timer = setTimeout(() => finish(null), 1_000);
    socket.once("error", () => finish(null));
    socket.connect(53, "1.1.1.1", () => { if (!settled) finish(socket.address().address); });
  });
  return findLanUrl(port, networkInterfaces(), routedAddress);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return isPreferredLanIpv4(address) || (parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function isPreferredLanIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168);
}

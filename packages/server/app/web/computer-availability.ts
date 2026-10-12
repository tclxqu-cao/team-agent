export type ComputerAvailability = "checking" | "online" | "offline";

/** Probe an existing public asset without sending an origin's authorization. */
export async function probeComputerAvailability(origin: string, signal?: AbortSignal): Promise<ComputerAvailability> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) return "offline";
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 4000);
  try {
    const url = new URL("/pwa/icon-192.png", origin);
    url.searchParams.set("online", String(Date.now()));
    const response = await fetch(url, { mode: "no-cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
    return response.type === "opaque" || response.ok ? "online" : "offline";
  } catch { return "offline"; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

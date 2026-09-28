interface FlowStudioConfig {
  entryUrl?: string | null;
}

export function normalizeDesktopFlowStudioEntryUrl(
  configuredUrl: string,
): string | null {
  try {
    const entry = new URL(configuredUrl);
    if (entry.protocol !== "http:" && entry.protocol !== "https:") return null;
    return entry.toString();
  } catch {
    return null;
  }
}

export async function resolveDesktopFlowStudioEntryUrl(): Promise<string | null> {
  try {
    const service = window.sharedServiceApi;
    if (!service?.request) return null;
    const response = await service.request("/api/flow-studio/config", "GET");
    if (response.status !== 200) return null;
    const configuredUrl = (JSON.parse(response.body) as FlowStudioConfig).entryUrl?.trim();
    if (!configuredUrl) return null;
    return normalizeDesktopFlowStudioEntryUrl(configuredUrl);
  } catch {
    return null;
  }
}

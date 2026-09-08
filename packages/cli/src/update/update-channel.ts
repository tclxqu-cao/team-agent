// The published CLI package does not depend on @agent/core, so the update
// channel rules are duplicated here. Keep them in sync with
// packages/core/src/domain/update/update-release.ts.
export type UpdateChannel = "latest" | "preview";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;

export function parseAgentRoamVersion(value: string): { core: [number, number, number]; preview: number | null } | null {
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    preview: match[4] === undefined ? null : Number(match[4]),
  };
}

// A prerelease installation follows the preview channel; a stable installation
// follows latest. Preview users are also offered a newer stable release so they
// can migrate to the stable track without reinstalling.
export function resolveUpdateChannel(currentVersion: string): UpdateChannel {
  const parsed = parseAgentRoamVersion(currentVersion);
  if (!parsed) throw new Error("invalid AgentRoam version");
  return parsed.preview === null ? "latest" : "preview";
}

export function resolveReleaseChannel(version: string): UpdateChannel {
  const parsed = parseAgentRoamVersion(version);
  if (!parsed) throw new Error("invalid AgentRoam version");
  return parsed.preview === null ? "latest" : "preview";
}

export function registryUrlsForChannel(channel: UpdateChannel, registryBase: string): string[] {
  return channel === "preview" ? [`${registryBase}/latest`, `${registryBase}/preview`] : [`${registryBase}/latest`];
}

export function parseChannelVersion(value: unknown, channel: UpdateChannel): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseAgentRoamVersion(value);
  if (!parsed) return null;
  if (parsed.preview === null) return value;
  return channel === "preview" ? value : null;
}

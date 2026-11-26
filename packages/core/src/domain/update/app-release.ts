import {
  AGENTROAM_RELEASE_BASE,
  AGENTROAM_REPOSITORY_BASE,
  compareAgentRoamVersions,
  parseAgentRoamVersion,
  type UpdateAsset,
  type UpdatePlatform,
} from "./update-release.js";

const RELEASES_API = "https://api.github.com/repos/tclxqu-cao/team-agent/releases?per_page=50";
const RELEASES_PAGE = `${AGENTROAM_REPOSITORY_BASE}/releases`;
const TAG_PATH = `${new URL(RELEASES_PAGE).pathname}/tag/`;

export type DesktopEdition = "desktop" | "desktop-lite";
export type AppUpdateTarget = { client: DesktopEdition; platform: UpdatePlatform } | { client: "android"; platform: "android" };

interface AppRelease {
  version: string;
  asset: UpdateAsset;
}

interface ReleaseCoordinates {
  version: string;
  baseUrl: string;
  fileName: string;
}

function coordinates(tag: string, target: AppUpdateTarget): ReleaseCoordinates | null {
  // Older full desktop installers were published alongside the CLI. Exact
  // asset matching keeps a CLI-only release from becoming a desktop update.
  const prefix = target.client === "desktop" && tag.startsWith("v") ? "v" : `${target.client}-v`;
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  if (!parseAgentRoamVersion(version)) return null;
  const name = target.client === "desktop-lite" ? "AgentRoam-Lite" : "AgentRoam";
  const fileName = target.platform === "android" ? `AgentRoam-${version}-android.apk`
    : target.platform === "darwin-arm64" ? `${name}-${version}-arm64.dmg`
      : `${name}-Setup-${version}-x64.exe`;
  return { version, baseUrl: `${AGENTROAM_RELEASE_BASE}/${tag}`, fileName };
}

function assetFromApi(value: unknown, release: ReleaseCoordinates): UpdateAsset | null {
  if (!value || typeof value !== "object") return null;
  const { name, state, size, digest, browser_download_url: url } = value as Record<string, unknown>;
  if (name !== release.fileName || state !== "uploaded" || url !== `${release.baseUrl}/${name}`) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) return null;
  return { fileName: name, sha256: digest.slice(7), size, url: url as string };
}

function fromApi(value: unknown, target: AppUpdateTarget, currentVersion: string): AppRelease | null {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub release list");
  let best: AppRelease | null = null;
  for (const release of value) {
    if (release?.draft !== false || typeof release.tag_name !== "string" || !release.published_at || !Array.isArray(release.assets)) continue;
    const match = coordinates(release.tag_name, target);
    if (!match || compareAgentRoamVersions(match.version, best?.version ?? currentVersion) <= 0) continue;
    const asset = release.assets.map((entry: unknown) => assetFromApi(entry, match)).find(Boolean);
    if (asset) best = { version: match.version, asset };
  }
  return best;
}

export async function readAppRelease(
  target: AppUpdateTarget,
  currentVersion: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AppRelease | null> {
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return fromApi(await response.json(), target, currentVersion);
  } catch { /* GitHub's shared unauthenticated REST quota may be exhausted. */ }

  // The release page and checksum assets don't consume the REST quota. Read
  // the edition search as well so frequent desktop releases don't hide APKs.
  const query = target.client === "desktop-lite" ? "lite" : target.client;
  const pages = await Promise.allSettled([RELEASES_PAGE, `${RELEASES_PAGE}?q=${query}`].map(async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error("GitHub releases unavailable");
    return [...(await response.text()).matchAll(/\bhref="([^"<>]+)"/g)].flatMap(([, href]) => {
      const path = href.startsWith("https://github.com/") ? href.slice("https://github.com".length) : href;
      return path.startsWith(TAG_PATH) ? [path.slice(TAG_PATH.length)] : [];
    });
  }));
  const tags = new Set(pages.flatMap((result) => result.status === "fulfilled" ? result.value : []));
  if (!tags.size) throw new Error("GitHub releases unavailable");
  const candidates = [...tags]
    .map((tag) => coordinates(tag, target))
    .filter((release): release is ReleaseCoordinates => Boolean(release && compareAgentRoamVersions(release.version, currentVersion) > 0))
    .sort((left, right) => compareAgentRoamVersions(right.version, left.version));

  const signal = AbortSignal.timeout(timeoutMs);
  for (const release of candidates) {
    const response = await fetchImpl(`${release.baseUrl}/SHA256SUMS`, { signal });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error("Release checksums unavailable");
    const digest = (await response.text()).split(/\r?\n/)
      .map((line) => /^([a-f0-9]{64})[ \t]+\*?(\S+)$/.exec(line.trim()))
      .find((match) => match?.[2] === release.fileName)?.[1];
    if (digest) return {
      version: release.version,
      asset: { fileName: release.fileName, sha256: digest, url: `${release.baseUrl}/${release.fileName}` },
    };
  }
  return null;
}

import { isWebMediaUrl, WEBAPP_ARTIFACT_OPEN_TYPE } from "../../../core/src/domain/web-console/WebArtifactBridge";

export type ArtifactBridgeWindow = Pick<Window, "location"> & {
  parent: Pick<Window, "postMessage">;
};

let requestSequence = 0;

/** A producer can publish a copy of a temporary image under the host's existing preview root. */
export function publishedTempImagePath(path: unknown): string | null {
  if (typeof path !== "string" || /[\\\0\r\n?#]/.test(path)) return null;
  const relative = /^\/(?:private\/)?tmp\/(.+)$/.exec(path)?.[1];
  if (!relative || !/\.(?:png|jpe?g|webp|gif|bmp|ico)$/i.test(relative)) return null;
  if (relative.split("/").some(part => !part || part === "." || part === "..")) return null;
  return `~/.agentroam/artifacts/tmp/${relative}`;
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function resolveWebArtifactPath(value: string, workspacePath?: string | null, homePath?: string | null): string | null {
  const candidate = value.trim();
  if (!candidate || /[\0\r\n]/.test(candidate)) return null;
  if (isWebMediaUrl(candidate)) return candidate;
  if (candidate.startsWith("~/")) {
    const relative = candidate.slice(2);
    if (!relative || relative.split(/[\\/]/).includes("..")) return null;
    return homePath ? resolveWebArtifactPath(relative, homePath) : candidate;
  }
  if (isAbsoluteHostPath(candidate)) return candidate;
  if (!workspacePath || !isAbsoluteHostPath(workspacePath)) return null;

  const segments = candidate.replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  const separator = /^[A-Za-z]:[\\/]/.test(workspacePath) || workspacePath.startsWith("\\\\") ? "\\" : "/";
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${segments.join(separator)}`;
}

export function postWebArtifactOpen(
  path: string,
  context: ArtifactBridgeWindow = window,
  revealOnly?: true,
): boolean {
  if ((context.parent as unknown) === context) return false;
  requestSequence += 1;
  context.parent.postMessage({
    type: WEBAPP_ARTIFACT_OPEN_TYPE,
    requestId: requestSequence,
    path,
    ...(revealOnly ? { revealOnly } : {}),
  }, context.location.origin);
  return true;
}

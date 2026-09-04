import { WEBAPP_ARTIFACT_OPEN_TYPE } from "../../../core/src/domain/web-console/WebArtifactBridge";

export type ArtifactBridgeWindow = Pick<Window, "location"> & {
  parent: Pick<Window, "postMessage">;
};

let requestSequence = 0;

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function resolveWebArtifactPath(value: string, workspacePath?: string | null): string | null {
  const candidate = value.trim();
  if (!candidate || /[\0\r\n]/.test(candidate)) return null;
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
): boolean {
  if ((context.parent as unknown) === context) return false;
  requestSequence += 1;
  context.parent.postMessage({
    type: WEBAPP_ARTIFACT_OPEN_TYPE,
    requestId: requestSequence,
    path,
  }, context.location.origin);
  return true;
}

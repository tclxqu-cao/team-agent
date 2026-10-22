import { isWebMediaUrl } from "../../../core/src/domain/web-console/WebArtifactBridge";

export function messageMediaKind(path: string): "image" | "video" | null {
  let pathname = path;
  if (/^https?:\/\//i.test(path)) {
    if (!isWebMediaUrl(path)) return null;
    pathname = new URL(path).pathname;
  } else if ((/^[A-Za-z][\w+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) || /[\0\r\n?#]/.test(path)) {
    return null;
  }
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(pathname)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/i.test(pathname)) return "video";
  return null;
}

export function resolveMessageMediaPath(path: string, workspacePath?: string | null): string | null {
  if (/^(?:https?:\/\/|\/|~\/|[A-Za-z]:[\\/])/i.test(path)) return path;
  if (!workspacePath || !messageMediaKind(path)) return null;
  const separator = /^[A-Za-z]:\\/.test(workspacePath) ? "\\" : "/";
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${path}`;
}

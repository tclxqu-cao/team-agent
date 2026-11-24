export interface FileTreeRevealRequest {
  path: string;
  requestId: number;
  rootAtParent?: boolean;
}

export function normalizeFileTreePath(path: string): string {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replaceAll("\\", "/") : path;
  const unc = /^\/\/[^/]+\/[^/]+/.test(windows);
  const normalized = windows.replace(/\/{2,}/g, "/");
  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === "/") return normalized;
  return (unc ? "/" : "") + normalized.replace(/\/+$/, "");
}

export function parentDirectory(path: string): string {
  const normalized = normalizeFileTreePath(path);
  const slash = normalized.lastIndexOf("/");
  if (slash === 2 && /^[A-Za-z]:\//.test(normalized)) return normalized.slice(0, 3);
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeFileTreePath(path);
  const normalizedRoot = normalizeFileTreePath(root);
  return normalizedPath.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`);
}

export function ancestorDirectories(root: string, filePath: string): string[] {
  const normalizedRoot = normalizeFileTreePath(root);
  if (!isPathInsideRoot(filePath, normalizedRoot)) return [];
  const parent = parentDirectory(filePath);
  if (parent === normalizedRoot) return [normalizedRoot];

  const relative = parent.slice(normalizedRoot.length + (normalizedRoot.endsWith("/") ? 0 : 1));
  const ancestors = [normalizedRoot];
  let current = normalizedRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = current.endsWith("/") ? current + segment : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
}

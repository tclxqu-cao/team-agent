export interface FileTreeRevealRequest {
  path: string;
  requestId: number;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function parentDirectory(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function ancestorDirectories(root: string, filePath: string): string[] {
  const normalizedRoot = normalizePath(root);
  if (!isPathInsideRoot(filePath, normalizedRoot)) return [];
  const parent = parentDirectory(filePath);
  if (parent === normalizedRoot) return [normalizedRoot];

  const relative = parent.slice(normalizedRoot === "/" ? 1 : normalizedRoot.length + 1);
  const ancestors = [normalizedRoot];
  let current = normalizedRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
}

interface SidebarDirectoryProject {
  description: string;
}

interface SidebarDirectoryContextMenuOptions {
  isInvalid: boolean;
  supported: boolean;
  webShell: boolean;
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function getDesktopDirectoryContextMenuPath(
  project: SidebarDirectoryProject,
  options: SidebarDirectoryContextMenuOptions,
): string | null {
  if (options.webShell || options.isInvalid || !options.supported) return null;
  const path = project.description;
  if (!path || /[\0\r\n]/.test(path) || !isAbsoluteHostPath(path)) return null;
  return path;
}

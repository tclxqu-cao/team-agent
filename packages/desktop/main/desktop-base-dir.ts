export function resolveDesktopBaseDir(
  appPath: string,
  isPackaged: boolean,
  userDataPath: string,
): string {
  return isPackaged ? userDataPath : appPath;
}

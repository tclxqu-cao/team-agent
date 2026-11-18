type ShowFileContextMenu = (path: string) => Promise<{ shown: true }>;

/** File manager actions belong to the desktop device, never an HTTP URL or service. */
export function requestArtifactFileContextMenu(
  event: Pick<MouseEvent, "preventDefault">,
  path: string,
  showMenu?: ShowFileContextMenu,
): Promise<{ shown: true }> | null {
  if (!showMenu || /[\0\r\n]/.test(path) || !(
    path.startsWith("/") || path.startsWith("~/")
    || /^[A-Za-z]:[\\/]/.test(path)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path)
  )) return null;
  event.preventDefault();
  return showMenu(path);
}

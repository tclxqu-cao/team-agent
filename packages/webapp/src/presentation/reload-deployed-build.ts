/** Refresh the shell together with its iframe so navigation protocols stay in sync. */
export function reloadDeployedBuild(): void {
  if (window.parent !== window) {
    try {
      if (window.parent.location.origin === window.location.origin) {
        window.parent.location.reload();
        return;
      }
    } catch { /* Native shells can keep their parent in another origin. */ }
  }
  window.location.reload();
}

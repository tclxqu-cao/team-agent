export function printLocalDesktopUrl(localUrl: string, log: (line: string) => void = console.log, platform: NodeJS.Platform = process.platform): void {
  log(`Local-only desktop authorization (open on this computer, not your phone): ${localUrl.replace(/\/$/, '')}/web`);
  log('Authorize again: agentroam desktop authorize. Browser fallback: open the local URL on this computer, pair, then click Remote Authorization (shield icon).');
  if (platform === 'win32') log('Click Enable Sharing. Keep Windows signed in and unlocked; UAC secure desktop and administrator windows are not supported.');
  else log('Grant Screen Recording and Accessibility permissions when prompted, then click Enable Sharing.');
}

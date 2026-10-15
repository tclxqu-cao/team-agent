/** Existing registrations retain their roots and service settings. */
export function runtimeServiceArguments(cli, dataDir, homeDirectory, configured) {
  return configured ? [cli, "service", "start"] : [cli, "service", "install", "--data-dir", dataDir, "--root", homeDirectory, "--no-qr"];
}

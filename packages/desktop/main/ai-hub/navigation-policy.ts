export function isGoogleAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (hostname === "accounts.google.com" || hostname.endsWith(".accounts.google.com"));
  } catch {
    return false;
  }
}

// Keep release selection shared by the browser and contract tests.
export const assetPatterns = {
  mac: [/darwin.*arm64.*\.dmg$/i, /(?:mac|arm64).*\.dmg$/i, /\.dmg$/i],
  windows: [/(?:x64|amd64).*\.exe$/i, /\.exe$/i, /\.msi$/i],
  android: [/\.apk$/i],
};
export function selectAssets(releases) {
  const published = releases
    .filter((release) => !release.draft)
    .sort(
      (a, b) =>
        Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0),
    );
  return Object.fromEntries(
    Object.entries(assetPatterns).map(([platform, patterns]) => {
      for (const release of published) {
        const assets = (release.assets || []).filter((asset) => {
          if (platform === "mac" && /(?:x64|x86_64|intel)/i.test(asset.name))
            return false;
          if (platform === "windows" && /(?:arm64|aarch64)/i.test(asset.name))
            return false;
          try {
            const url = new URL(asset.browser_download_url);
            return (
              url.protocol === "https:" &&
              url.hostname === "github.com" &&
              url.pathname.startsWith(
                "/tclxqu-cao/team-agent/releases/download/",
              )
            );
          } catch {
            return false;
          }
        });
        for (const pattern of patterns) {
          const asset = assets.find(
            (a) =>
              pattern.test(a.name) &&
              !/(?:blockmap|sha256|checksums|unpacked|ia32)/i.test(a.name),
          );
          if (asset) return [platform, { ...asset, tag: release.tag_name }];
        }
      }
      return [platform, null];
    }),
  );
}

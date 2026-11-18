import { describe, expect, it } from "vitest";
import { webAppCacheControl } from "./web-app-cache.mjs";

describe("web app asset caching", () => {
  it.each(["assets/index-ChdWSTQ7.js", "assets/App-CrZstnCH.css", "assets/qoder-CGHn7M84.png", "assets/fonts/ui-12345678.woff2"])("caches the immutable build asset %s", path => {
    expect(webAppCacheControl(path)).toBe("public, max-age=31536000, immutable");
  });

  it.each(["index.html", "assets/index.html", "assets/preview-12345678.html", "assets/config.json", "assets/index.js", "dictation-audio-worklet.js", "sw.js", "index-12345678.js"])("revalidates unversioned resources and HTML: %s", path => {
    expect(webAppCacheControl(path)).toBe("no-cache");
  });
});

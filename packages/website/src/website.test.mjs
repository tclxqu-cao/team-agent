import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { selectAssets } from "../public/releases.js";
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const asset = (name, path = name) => ({
  name,
  size: 1000,
  browser_download_url: `https://github.com/tclxqu-cao/team-agent/releases/download/v1/${path}`,
});
test("release selection supports preview-only releases and picks newest platform-specific assets", () => {
  const result = selectAssets([
    {
      tag_name: "old",
      published_at: "2026-09-01",
      assets: [asset("AgentRoam-arm64.dmg"), asset("AgentRoam-x64.exe")],
    },
    {
      tag_name: "preview",
      prerelease: true,
      published_at: "2026-10-01",
      assets: [asset("AgentRoam-arm64.dmg"), asset("mobile.apk")],
    },
    {
      tag_name: "draft",
      draft: true,
      published_at: "2026-10-02",
      assets: [asset("Windows-x64.exe")],
    },
  ]);
  assert.equal(result.mac.tag, "preview");
  assert.equal(result.android.tag, "preview");
  assert.equal(result.windows.tag, "old");
});
test("unpublished, unsafe and metadata assets never become download links", () => {
  assert.deepEqual(selectAssets([]), {
    mac: null,
    windows: null,
    android: null,
  });
  const result = selectAssets([
    {
      assets: [
        asset("app.exe.blockmap"),
        {
          name: "app.exe",
          browser_download_url: "https://example.org/app.exe",
        },
        { name: "app.apk", browser_download_url: "javascript:alert(1)" },
      ],
    },
  ]);
  assert.deepEqual(result, { mac: null, windows: null, android: null });
});
test("every local link, image, script and guide anchor resolves under a project Pages base path", async () => {
  const files = ["index.html", "download.html", "guide.html"];
  for (const file of files) {
    const html = await readFile(root + file, "utf8");
    assert.match(html, /lang="zh-CN"/);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(?:https?:|data:)/.test(url)) continue;
      assert.ok(
        !url.startsWith("/"),
        `absolute URL breaks project base: ${url}`,
      );
      const [resource, id] = url.split("#");
      const path = resource.split("?")[0];
      if (path) await access(root + path);
      if (id) {
        const target = path ? await readFile(root + path, "utf8") : html;
        assert.ok(
          target.includes(`id="${id}"`),
          `${file}: broken anchor ${url}`,
        );
      }
    }
  }
});

test("unsupported CPU installers are not offered as supported platform downloads", () => {
  const result = selectAssets([
    { assets: [asset("AgentRoam-x64.dmg"), asset("AgentRoam-arm64.exe")] },
  ]);
  assert.equal(result.mac, null);
  assert.equal(result.windows, null);
});

test("published fallback provides direct downloads for every supported platform", async () => {
  const { releaseSnapshot } = await import("../public/release-snapshot.js");
  const assets = selectAssets(releaseSnapshot);
  const versions = { mac: "27", windows: "27", android: "24" };
  for (const [platform, version] of Object.entries(versions)) {
    const tag = `desktop-v0.2.0-preview.${version}`;
    assert.equal(assets[platform].tag, tag);
    assert.ok(assets[platform].size > 1000000);
    assert.ok(assets[platform].browser_download_url.includes(`/${tag}/`));
  }
});

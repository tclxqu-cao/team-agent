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
  ], "full");
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
  for (const edition of ["lite", "full"]) {
    const assets = selectAssets(releaseSnapshot, edition);
    for (const platform of ["mac", "windows", "android"]) {
      const tag = platform === "android" ? "desktop-v0.2.0-preview.24"
        : edition === "lite" ? "desktop-lite-v0.2.0-preview.29" : "desktop-v0.2.0-preview.29";
      assert.equal(assets[platform].tag, tag);
      assert.ok(assets[platform].size > 1000000);
      assert.ok(assets[platform].browser_download_url.includes(`/${tag}/`));
    }
  }
});


test("Lite stays the default even when a newer full edition is published", () => {
  const releases = [
    { tag_name: "lite", published_at: "2026-10-16", assets: [asset("AgentRoam-Lite-0.2.0-preview.28-arm64.dmg"), asset("AgentRoam-Lite-Setup-0.2.0-preview.28-x64.exe")] },
    { tag_name: "full-newer", published_at: "2026-10-17", assets: [asset("AgentRoam-0.2.0-preview.29-arm64.dmg"), asset("AgentRoam-Setup-0.2.0-preview.29-x64.exe")] },
  ];
  assert.equal(selectAssets(releases).mac.tag, "lite");
  assert.equal(selectAssets(releases).windows.tag, "lite");
  assert.equal(selectAssets(releases, "full").mac.tag, "full-newer");
  assert.equal(selectAssets(releases, "full").windows.tag, "full-newer");
  assert.equal(selectAssets([releases[0]], "full").mac, null);
  assert.equal(selectAssets([releases[1]], "lite").windows, null);
});

test("download page offers both editions and explains the shared phone capabilities", async () => {
  const html = await readFile(root + "download.html", "utf8");
  const { releaseSnapshot } = await import("../public/release-snapshot.js");
  for (const platform of ["mac", "windows"]) for (const edition of ["lite", "full"]) {
    const attributes = `data-platform="${platform}" data-edition="${edition}"`;
    const href = selectAssets(releaseSnapshot, edition)[platform].browser_download_url;
    assert.ok(html.includes(`${attributes} href="${href}"`), "published download survives disabled JavaScript");
  }
  assert.ok(html.includes(`data-platform="android" data-edition="lite" href="${selectAssets(releaseSnapshot).android.browser_download_url}"`), "Android download survives disabled JavaScript");
  assert.ok(html.indexOf("桌面端 · 简易版") < html.indexOf('id="full"'));
  assert.match(html, /简易版和全量版，怎么选/);
  assert.match(html, /二维码、刷新、重新授权/);
  assert.match(html, /复用 CLI 安装流程/);
});

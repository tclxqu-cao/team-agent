import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// 直接引 core 源码而不是 @agent/core：后者指向 dist，会变成「拿旧构建产物做契约」。
import {
  CLI_INSTALL_FILE_NAMES as CORE_INSTALL_FILE_NAMES,
  buildCliInstallManifestUrl as coreBuildManifestUrl,
  buildCliInstallScriptUrl as coreBuildScriptUrl,
  validateCliInstallManifest as coreValidate,
} from "../../../core/src/domain/update/update-release.js";
import {
  CLI_INSTALL_FILE_NAMES,
  buildCliInstallManifestUrl,
  buildCliInstallScriptUrl,
  validateCliInstallManifest,
} from "./update-install.js";

const sha256 = "d".repeat(64);
const manifest = () => ({
  schemaVersion: 1,
  installers: {
    "darwin-arm64": { fileName: "install-agentroam.sh", sha256, size: 11_625 },
    "windows-amd64": { fileName: "install-agentroam.ps1", sha256, size: 13_155 },
  },
});

describe("CLI install coordinates", () => {
  // CLI 是已发布包，不能依赖 @agent/core，因此这边刻意复制了一份坐标。
  // 这条用例就是那份复制的护栏：两边一旦漂移立刻失败。
  it("stays in sync with the core copy", () => {
    expect(CLI_INSTALL_FILE_NAMES).toEqual(CORE_INSTALL_FILE_NAMES);
    expect(buildCliInstallManifestUrl()).toBe(coreBuildManifestUrl());
    for (const fileName of Object.values(CLI_INSTALL_FILE_NAMES)) {
      expect(buildCliInstallScriptUrl(fileName)).toBe(coreBuildScriptUrl(fileName));
    }
    for (const platform of ["darwin-arm64", "windows-amd64"] as const) {
      expect(validateCliInstallManifest(manifest(), platform)).toEqual(coreValidate(manifest(), platform));
    }
  });

  it("rejects malformed manifests and unwelcome file names", () => {
    expect(validateCliInstallManifest(manifest(), "windows-amd64")).toEqual({ fileName: "install-agentroam.ps1", sha256, size: 13_155 });
    expect(() => validateCliInstallManifest({ schemaVersion: 2, installers: {} }, "darwin-arm64")).toThrow("identity");
    expect(() => validateCliInstallManifest({ schemaVersion: 1 }, "darwin-arm64")).toThrow("identity");
    expect(() => validateCliInstallManifest({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "other.sh", sha256 } } }, "darwin-arm64")).toThrow("metadata");
    expect(() => validateCliInstallManifest({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256: "nope" } } }, "darwin-arm64")).toThrow("metadata");
    expect(() => validateCliInstallManifest({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256, size: 0 } } }, "darwin-arm64")).toThrow("size");
    expect(() => buildCliInstallScriptUrl("../payload")).toThrow();
  });

  // 往返一致：仓库里那份清单必须和安装脚本的实际字节对得上，
  // 否则客户端下载后 sha256 校验必然失败。
  it("ships a manifest that matches the installer scripts byte for byte", () => {
    const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../../install/install-manifest.json", import.meta.url)), "utf8"));
    for (const platform of ["darwin-arm64", "windows-amd64"] as const) {
      const asset = validateCliInstallManifest(shipped, platform);
      const bytes = readFileSync(fileURLToPath(new URL(`../../install/${asset.fileName}`, import.meta.url)));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      expect(asset.size).toBe(bytes.length);
    }
  });
});

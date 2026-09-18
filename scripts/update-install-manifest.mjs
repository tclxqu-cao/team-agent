#!/usr/bin/env node
/**
 * 生成 / 校验 CLI 安装清单 `packages/cli/install/install-manifest.json`。
 *
 * 背景：CLI 的自动更新不再依赖发版产物，改为从仓库分支 raw 路径拉安装脚本。
 * 客户端仍要校验 sha256，所以脚本哈希需要一个稳定来源 —— 就是本文件生成的清单。
 *
 * 唯一源头 = `packages/cli/install/install-agentroam.{sh,ps1}` 的实际字节。
 * 清单刻意不含 version 字段：安装脚本与版本无关（运行时按 npm dist-tag 解析，
 * 或被 AGENTROAM_VERSION 钉住），因此一份清单对所有版本都成立。
 *
 * 用法：
 *   node scripts/update-install-manifest.mjs             # 重算并写回清单
 *   node scripts/update-install-manifest.mjs --dry-run    # 只看会改什么
 *   node scripts/update-install-manifest.mjs --check      # 校验是否已一致（退出码 1 = 漂移）
 *
 * 注意：哈希的是文件原始字节，不做换行归一化 —— GitHub raw 分发的就是这份字节。
 * `.gitattributes` 已把这两个脚本钉成 LF，避免 Windows 检出把 CRLF 写进索引后
 * 静默改变哈希。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALL_DIR = resolve(ROOT, "packages/cli/install");
const MANIFEST_PATH = resolve(INSTALL_DIR, "install-manifest.json");

/** 平台 → 安装脚本文件名。与 packages/core 的 CLI_INSTALL_FILE_NAMES 保持一致。 */
const INSTALLERS = {
  "darwin-arm64": "install-agentroam.sh",
  "windows-amd64": "install-agentroam.ps1",
};

export function buildInstallManifest() {
  const installers = {};
  for (const [platform, fileName] of Object.entries(INSTALLERS)) {
    const bytes = readFileSync(resolve(INSTALL_DIR, fileName));
    installers[platform] = {
      fileName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
  return { schemaVersion: 1, installers };
}

export function serializeInstallManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check");

  const next = serializeInstallManifest(buildInstallManifest());
  let current = null;
  try {
    current = readFileSync(MANIFEST_PATH, "utf8");
  } catch {
    // 首次生成时清单还不存在。
  }

  const rel = MANIFEST_PATH.replace(`${ROOT}/`, "");

  if (current === next) {
    console.log(`CLI 安装清单已是最新 ✓  ${rel}`);
    return;
  }

  if (checkOnly) {
    console.error(`CLI 安装清单与 packages/cli/install 下的脚本不一致：${rel}`);
    if (current === null) {
      console.error("  清单文件不存在。");
    } else {
      for (const line of describeDrift(JSON.parse(current), JSON.parse(next))) console.error(`  ${line}`);
    }
    console.error("\n跑 node scripts/update-install-manifest.mjs 修复。");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[将改] ${rel}`);
    return;
  }
  writeFileSync(MANIFEST_PATH, next);
  console.log(`[已写] ${rel}`);
}

/** 列出哈希/大小漂移，便于排查是谁改了脚本却忘了同步清单。 */
function describeDrift(current, next) {
  const lines = [];
  for (const [platform, asset] of Object.entries(next.installers)) {
    const before = current?.installers?.[platform];
    if (!before) {
      lines.push(`${platform}: 清单缺失，将补上 ${asset.fileName}`);
      continue;
    }
    if (before.fileName !== asset.fileName) lines.push(`${platform}: 文件名 ${before.fileName} → ${asset.fileName}`);
    if (before.sha256 !== asset.sha256) lines.push(`${platform}: ${asset.fileName} 哈希已变（脚本被改过？）`);
    else if (before.size !== asset.size) lines.push(`${platform}: ${asset.fileName} 大小 ${before.size} → ${asset.size}`);
  }
  return lines.length > 0 ? lines : ["清单内容有差异。"];
}

// 作为脚本直接运行时才执行；被测试 import 时只导出函数。
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();

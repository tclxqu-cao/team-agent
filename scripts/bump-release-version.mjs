#!/usr/bin/env node
/**
 * 一条命令同步所有发布版本号。
 *
 * 版本唯一源头 = `packages/cli/package.json` 的 version。
 * CLI 运行时代码（src/platform-packages.ts、src/tunnel/public-readiness.ts、
 * bin/node-preflight.mjs）已经自动读取，无需同步；本脚本只负责 npm 发布元数据：
 *
 *   - packages/cli/package.json          version + optionalDependencies 里的各平台包
 *   - packages/<平台包>/package.json       version
 *   - packages/<平台包>/manifest.json      packageVersion
 *
 * 用法：
 *   node scripts/bump-release-version.mjs 0.2.0-preview.27            # 写入
 *   node scripts/bump-release-version.mjs 0.2.0-preview.27 --dry-run   # 只看会改什么
 *   node scripts/bump-release-version.mjs --check                      # 校验当前是否已一致（退出码 1 = 不一致）
 *
 * 采用「精确文本替换」而不是 JSON 重新序列化，保证 diff 最小、不重排键序。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI_PKG = resolve(ROOT, "packages/cli/package.json");

/** 平台包名 → 目录名：去掉 scope 与 "agentroam-" 前缀 */
function dirOf(packageName) {
  const bare = packageName.replace(/^@[^/]+\//, "");
  return resolve(ROOT, "packages", bare.replace(/^agentroam-/, ""));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 只替换指定 key 对应的版本值，其余文本原样保留 */
function replaceVersion(text, key, next) {
  const re = new RegExp(`("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*")([^"]+)(")`);
  return text.replace(re, (_, head, _old, tail) => head + next + tail);
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check");
  const requested = argv.find((a) => !a.startsWith("--"));

  const cliJson = readJson(CLI_PKG);
  const currentVersion = cliJson.version;
  const platformNames = Object.keys(cliJson.optionalDependencies ?? {});

  const next = requested ?? currentVersion;

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
    console.error(`版本号格式非法: ${next}`);
    process.exit(2);
  }

  const targets = [
    { file: CLI_PKG, keys: ["version", ...platformNames] },
    ...platformNames.map((name) => ({
      file: resolve(dirOf(name), "package.json"),
      keys: ["version"],
    })),
    ...platformNames.map((name) => ({
      file: resolve(dirOf(name), "manifest.json"),
      keys: ["packageVersion"],
    })),
  ];

  let changed = 0;
  const stale = [];

  for (const { file, keys } of targets) {
    const rel = file.replace(`${ROOT}/`, "");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      console.warn(`  [跳过] 文件不存在: ${rel}`);
      continue;
    }
    let updated = text;
    for (const key of keys) {
      updated = replaceVersion(updated, key, next);
    }
    if (updated === text) continue;

    if (checkOnly) {
      stale.push(rel);
      continue;
    }
    changed += 1;
    if (dryRun) {
      console.log(`  [将改] ${rel}`);
    } else {
      writeFileSync(file, updated);
      console.log(`  [已改] ${rel}`);
    }
  }

  if (checkOnly) {
    if (stale.length === 0) {
      console.log(`所有发布元数据均为 ${currentVersion} ✓`);
      return;
    }
    console.error(`以下文件版本不是 ${currentVersion}（源头 packages/cli/package.json）：`);
    for (const rel of stale) console.error(`  ${rel}`);
    console.error(`\n跑 node scripts/bump-release-version.mjs ${currentVersion} 修复。`);
    process.exit(1);
  }

  if (changed === 0) {
    console.log(`所有发布元数据已经是 ${next}，无需改动。`);
  } else {
    console.log(`\n${dryRun ? "预计改动" : "已同步"} ${changed} 个文件 → ${next}`);
    if (!dryRun) {
      console.log("CLI 运行时代码无需改动（自动读 package.json）。提交后即可发布。");
    }
  }
}

main();

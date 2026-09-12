#!/usr/bin/env node
/**
 * 壳内 HTML 补丁（只在 packages/mobile 的拷贝产物上生效）：
 * 原生壳 WebView 全屏铺底，状态栏（时间/信号/电池）会叠在应用头部上。
 * 注入安全区 padding + 把 .app-shell 的 100dvh 改为跟随内容盒。
 * 手机浏览器（:3000）与桌面端加载的是各自原始文件，完全不受影响。
 * 幂等：以 <style id="agentroam-shell-safe-area"> 为标记。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, "..");
const targets = [
  resolve(mobileDir, "ios/App/App/public/index.html"),
  resolve(mobileDir, "android/app/src/main/assets/public/index.html"),
];

const marker = 'id="agentroam-shell-safe-area"';
const style = `<style ${marker}>
  /* 仅原生壳：状态栏/Dynamic Island 区域让位给应用（env() 在浏览器里由浏览器自身处理） */
  body[data-web-shell="1"] {
    padding-top: env(safe-area-inset-top, 0px);
    box-sizing: border-box;
    background: var(--bg-surface, #fff);
  }
  body[data-web-shell="1"] .app-shell { height: 100% !important; }
</style>`;

let patched = 0;
for (const file of targets) {
  let html;
  try {
    html = readFileSync(file, "utf8");
  } catch {
    console.warn(`skip (missing): ${file}`);
    continue;
  }
  if (html.includes(marker)) {
    console.log(`already patched: ${file}`);
    continue;
  }
  if (!html.includes("</head>")) {
    console.warn(`skip (no </head>): ${file}`);
    continue;
  }
  writeFileSync(file, html.replace("</head>", `${style}\n</head>`));
  patched += 1;
  console.log(`patched: ${file}`);
}
if (patched === 0) process.exitCode = 1;

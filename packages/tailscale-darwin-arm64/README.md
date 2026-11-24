# tailscale 平台包（darwin-arm64）

本包只承载 **AgentRoam 内嵌组网** 所需的两个二进制：`tailscale`（CLI）与 `tailscaled`（用户态守护进程）。

## 为什么不是官方下载

Tailscale 官方只为 **Linux** 发布裸 `tgz`；macOS / Windows 只有 App / PKG / 安装器，
没有可再分发的裸二进制归档。因此本包的 `vendor/tailscale-darwin-arm64.tgz`
由 `scripts/build-tailscale-platform-package.mjs` 在**打包期**从上游源码（pinned tag）构建：

```bash
node scripts/build-tailscale-platform-package.mjs --target darwin-arm64 --version 1.104.4
```

构建产物入 `vendor/`（该目录已在 `.gitignore` 中，不入库），`manifest.json` 的
`size` / `sha256` 由脚本回写，运行时按 sha256 校验后安装到 `<dataDir>/bin`。

## 许可

上游 Tailscale 为 **BSD-3-Clause**，允许再分发；构建脚本会把上游 `LICENSE` 复制到本包目录。
本包不得暗示与 Tailscale Inc. 存在官方关联。

## 运行时降级

平台包缺失时（例如开发环境未构建），`ensureTailscaleBinaries()` 会回落 PATH 探测：
macOS 优先 `/opt/homebrew/bin`、`/usr/local/bin`（`brew install tailscale` 即可）。
生产打包必须带平台包，否则用户机器上会要求自行安装 Tailscale。

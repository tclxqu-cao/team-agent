# tailscale 平台包（Windows x64）

本包承载 **AgentRoam 内嵌组网** 所需的 `tailscale.exe` 与 `tailscaled.exe`。

## 构建

```bash
node scripts/build-tailscale-platform-package.mjs --target windows-amd64 --version 1.104.4
```

脚本从上游源码（pinned tag）以 `GOOS=windows GOARCH=amd64 CGO_ENABLED=0` 构建，
结果入 `vendor/tailscale-win32-x64.tgz`（不入库），`manifest.json` 的 `size`/`sha256` 自动回写。

> Windows 上 tailscaled 的用户态模式是否可用、以及与系统 TCP 栈的交互，
> 需在 M1 实机验证后确认；不行则退回「官方客户端 + 自定义控制面」（M2 形态）。

## 许可

上游 BSD-3-Clause，允许再分发；构建脚本复制上游 LICENSE。不得暗示官方关联。

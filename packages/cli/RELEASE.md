# AgentRoam 0.2.0-preview.3 macOS arm64 预览发布验收

面向：**仅 CLI + Web 控制台**，不含 desktop；同一局域网可直接扫码访问，跨网络时自动尝试 Cloudflare Quick Tunnel 和 Pinggy SSH 443 relay，**手机无需 VPN**。

## 一键打包

```bash
bun run pack:cli
# 产物:
# packages/cli/agentroam-0.2.0-preview.3.tgz
# packages/cloudflared-darwin-arm64/agentroam-cloudflared-darwin-arm64-0.2.0-preview.3.tgz
```

## 验收清单

| 步骤 | 命令 | 状态 |
|------|------|------|
| 构建 + standalone runtime | `bun run build:cli` | macOS arm64 已通过 |
| 双 tarball 审计 | `npm run pack:cli` | 已通过；主包 8,959 条目，平台包 4 条目，均小于 30 MB |
| Node 22 离线双包安装 + 本地启动 | `npm run verify:cli` | Node 22.22.0 已通过；SQLite、真实 zsh PTY、RFC1918 pairing URL 正常 |
| bundled cloudflared 解包 | `agentroam doctor` | cloudflared 2026.8.2 大小/SHA-256 校验、解包与执行权限通过 |
| Cloudflare → Pinggy → LAN 回退 | `npm run verify:cli:tunnel` | Cloudflare QUIC 注册成功但公网 readiness fetch 失败；自动关闭后 Pinggy SSH 443 成功 |
| pairing 公网 E2E | setup → Secure Cookie → WSS hello | Pinggy 全链路已通过；首次安全页进入后 pairing query 保留 |
| Windows ConPTY | `agentroam doctor` + 启动 | 不属于 macOS arm64 预览范围 |
| npm preview publish | 先平台包，后主包 | 2026-08-28 已发布并通过 automated validation |
| git commit / push | 见下方 | 本次未执行 |

## 分发给他人

```bash
# 方式 1: 直接发 tarball
scp packages/{cli/agentroam-0.2.0-preview.3.tgz,cloudflared-darwin-arm64/agentroam-cloudflared-darwin-arm64-0.2.0-preview.3.tgz} user@host:

# 对方安装（需 Node 22 + macOS arm64）
npm install ./agentroam-cloudflared-darwin-arm64-0.2.0-preview.3.tgz ./agentroam-0.2.0-preview.3.tgz
npx agentroam
```

```bash
# 方式 2: 发布后
npx agentroam@preview
```

## 平台说明

- **macOS arm64**：本次预览发布唯一支持的平台
- **macOS x64 / Windows x64**：留待跨平台分发方案完成后的正式版本
- tarball 内 `runtime/node_modules` 含预编译 native 模块，**安装时不再编译 Next/React**
- 当前 `better-sqlite3` 仅包含打包宿主机二进制；同一 npm name/version 不能直接发布多份平台 tarball，正式发布前必须先确定跨平台分发方案
- `preview.3` 启动时恢复 npm tarball 剥离的 `node-pty/spawn-helper` 执行权限，并在全新安装 smoke 中实际创建 PTY。
- Tunnel 下载或连接失败后，二维码优先使用 RFC1918 局域网地址，不再编码 `127.0.0.1`。
- cloudflared 从 npm 平台包离线解包并校验大小与 SHA-256，运行时不再访问 GitHub；之后才回退到 `PATH` 中的系统安装。
- 默认 relay 顺序是 Cloudflare → Pinggy → RFC1918 LAN，只有通过公网健康检查后才输出二维码。
- npm 首发曾自动保留 `latest=0.2.0-preview.1`；发布后必须重新复核 `preview` 与 `latest`。
- runtime staging 排除 Next 构建期 SWC、前端构建期 Xterm 包和非 darwin-arm64 的 `node-pty` prebuild，tarball 从 79.7 MB 降至 29.0 MB

## npm 发布结果

- `agentroam@0.2.0-preview.3`：29,106,251 bytes，SHA-256 `b1f8c408b9c9075dbe3d2813a72e959772c6ffa6346138287363e8263d8105c1`
- 主包 npm integrity：`sha512-hRMGgAqFfNJ4XDCFO6lwhSr1PE3KKNmBsbMxYoWsPkXKZyJav7F+J11SZ1ejeRGEryFLwOwP52EnFdxYXGepyA==`
- `agentroam-cloudflared-darwin-arm64@0.2.0-preview.3`：19,185,202 bytes，SHA-256 `7216a1d12caf90c5543879c8c775a4ed91f9636b673f16079b7e72404506974d`
- 平台包 npm integrity：`sha512-n3GLXp5JIQZjcuukK/11EAxxGchHuVLxMkmnvfoQ0Rb+h+Ab4NiWx9O//ak2B1OHyZdMkEEz5KLdnH1eQqDL2Q==`
- dist-tags：主包 `preview=0.2.0-preview.3`、`latest=0.2.0-preview.1`；平台包 `preview=latest=0.2.0-preview.3`。
- 官方 registry 空缓存安装两个 `.3` 包通过；`doctor`、cloudflared 2026.8.2 解包、local-only 健康接口与 SIGINT 退出通过。

## npm publish 前

1. 确认两个 `package.json` version
2. `npm login`
3. `npm publish packages/cloudflared-darwin-arm64/agentroam-cloudflared-darwin-arm64-0.2.0-preview.5.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false`
4. `npm publish packages/cli/agentroam-0.2.0-preview.5.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false`
5. 验证 `npx agentroam@preview doctor`

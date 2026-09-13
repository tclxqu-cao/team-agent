# AgentRoam 0.2.0-preview.17 macOS / Windows CLI 发布验收

## Desktop 安装包与客户端更新

CLI、常驻 WebApp 和 Desktop 共用一个 AgentRoam 版本。原生 CI 分别构建未签名的 macOS arm64 DMG `AgentRoam-<version>-arm64.dmg` 和 Windows x64 NSIS 安装包 `AgentRoam-Setup-<version>-x64.exe`，并和 `release-manifest.json`、`SHA256SUMS` 一起上传到同版本 Gitee Release。

客户端只把 npm 官方 registry 的 `agentroam@latest` 当成稳定更新开关。稳定版本的 schema-2 清单缺少任一 CLI 或 Desktop 安装包时必须失败；preview 清单保持 `preview` channel，不提醒普通用户。Desktop 安装包当前不签名，应用只下载、校验并在文件管理器中显示，绝不自动执行。

本地 preflight 和测试不得发布 npm、移动 dist-tag、推送 Git tag 或创建 Gitee Release。远程发布仍由显式 workflow 执行，保持六个平台包先于 launcher，并在 Gitee 资产验证与 soak 完成后才移动 `latest`。

支持平台：macOS arm64、Windows 10/11 x64，只要求 Node.js >=22.22.0，不限制更高主版本。
全部构建和打包在 macOS arm64 完成；Windows 只下载同一批产物做实机验证，
不安装 Bun、Python、Visual Studio Build Tools，也不运行 `node-gyp`。

## macOS 打包

```bash
PATH=/path/to/node-v22/bin:$PATH npm run pack:cli:all
```

最终目录 `dist/cli-release` 包含：

- 通用启动包 `agentroam-0.2.0-preview.17.tgz`
- macOS / Windows 各自的 runtime、cloudflared 和 TUI 包
- 校验文件 `SHA256SUMS`

runtime tarball 在打包时静态校验 native 文件格式和架构：macOS 必须为
Mach-O arm64，Windows 必须为 PE32+ x86-64。Windows `better-sqlite3` 和
`node-pty` 使用匹配平台和架构的 Node-API 预构建文件，缺失时直接中止打包。
runtime manifest v2 声明最低 Node 版本，不再限定 Node 22 / ABI 127；同一平台包在多个 Node 版本下运行验证。

## 安装器与常驻服务

版本化 `install-agentroam.sh` / `install-agentroam.ps1` 用于首次安装、升级和
修复。安装器校验 Node 最低版本和精确 CLI 后，默认注册当前用户服务、启动并验证
ready 状态；日常启停使用 `agentroam service start|stop|restart|status`。
重复安装会先停止已有服务，等待旧进程和平台注册退出，再注册新版本；
不删除数据目录中的会话、配对状态、托管运行时和日志。

macOS 使用用户 LaunchAgent，Windows 使用当前用户 Task Scheduler。前台和
服务运行期间都阻止系统因空闲进入睡眠，但不阻止显示器熄灭，也不修改全局
`pmset` / `powercfg`。Windows 的任务计划和 `ES_SYSTEM_REQUIRED` 必须由真实
Windows runner 验证，不能用 macOS 静态审计替代。

## 本机验收

macOS arm64：

```bash
node scripts/verify-cli-install.mjs --artifacts dist/cli-release
node scripts/verify-cli-tunnel.mjs --artifacts dist/cli-release --provider auto
```

Windows x64 PowerShell（将 macOS 生成的整个目录复制到相同位置）：

```powershell
node scripts/verify-cli-install.mjs --artifacts dist/cli-release
```

安装 smoke 会重新核验 `SHA256SUMS`，随后在全新临时目录完成：

- 从本地 tarball 安装通用包和当前平台的三个 optional package；纯 JS 依赖可从 registry 补齐
- `agentroam doctor`
- cloudflared `--version`
- `better-sqlite3` 建表、写入、读取
- macOS zsh PTY 或 Windows PowerShell ConPTY
- `agentroam start --local-only`、健康接口和 webapp 页面
- `service start|stop|status` 解析与平台控制器
- 安装器隔离模式不会注册开发机真实服务

## CI 约束

`.github/workflows/cli-release.yml` 和 `cli-release-verify.yml` 都遵循同一顺序：

1. macOS arm64 构建、打包、静态审计并完成 macOS smoke。
2. macOS job 上传 `dist/cli-release`。
3. Windows x64 job 下载该 artifact，只运行安装和实机 smoke，不重新构建。

只有 macOS 打包和 Windows 实机验证均通过，产物才满足发布条件。

## Agent 稳定版自动升级

`agent-runtime-upgrade` 每天读取 npm 官方 registry 的 `latest`，只跟踪 Codex、
Claude Agent SDK 和 OpenCode 的稳定版；预发布、降级以及 OpenCode CLI/SDK
版本不一致都会被拒绝。三个 Agent 独立升级，同一时间只保留一个活动候选。

候选会经过限定路径和依赖变更检查、单元测试、类型检查、生产构建、macOS
打包、Windows 安装验证以及 macOS/Windows 对应供应商账号的认证 smoke。兼容性失败最多允许
两次受限 Codex 自动修复；其他失败保留候选并转人工处理。验证通过后，CI 从
合并提交重新构建七个包，以 `preview` 发布并同步 Gitee。若 Gitee 同步失败，
健康的 npm `preview` 保持不变，自动化每小时从原始审计产物重试同步，并在两端
一致前阻止 `latest` 提升。Gitee 同步先将精确 GitHub merge commit 无强推地
推进 `master`，再创建 tag 和 Release；非快进分叉必须失败并停留在待同步状态。
macOS 和 Windows 在
24 小时内每小时从空 npm 缓存安装该精确版本并执行 smoke；每个六小时窗口
至少成功一次且最后一次成功不超过两小时，才将同一批不可变产物提升为
`latest`。失败只恢复 dist-tag，不执行 `npm unpublish`。

自动化需要以下相互隔离的 GitHub Environments：

- `agent-runtime-smoke-codex`：`PROVIDER_API_KEY`
- `agent-runtime-smoke-claude`：`PROVIDER_API_KEY`
- `agent-runtime-smoke-opencode`：`PROVIDER_API_KEY`、`OPENCODE_CONFIG_JSON`
- `agent-runtime-repair`：`OPENAI_API_KEY`
- `agent-runtime-publish-npm`：`NPM_TOKEN`
- `agent-runtime-publish-gitee`：`GITEE_TOKEN`

GitHub mirror 创建后，运行
`npm run configure:agent-runtime-github -- apply --repo caoqu/team-agent` 可幂等配置
非秘密控制面；随后使用同命令的 `audit` 子命令核对分支保护、Actions 权限、
Environment、标签、变量和 secret 名称。配置器不会读取或写入 secret 值。

在跟踪 issue 上添加 `promotion-hold` 可暂停提升；手动触发
`agent-runtime-soak` 可立即补跑一次双平台检查；手动触发
`agent-runtime-publish` 并指定 `preview` 或 `latest` 及已发布目标版本，可执行
紧急 dist-tag 回滚。仓库配置和标签清单见 `.github/agent-runtime-upgrade.md`。

本地 token 发布只用于自动化不可用时的应急处理，与 CI 的环境级凭据完全
分离。执行任何写操作前，先运行 `preflight` 以及对应命令的 `--dry-run`。

## npm 发布顺序

本仓库的 npm 发布统一使用发布时提供的 access token，不走浏览器 WebAuthn。token 只能写入权限受限的临时 npm user config，发布进程退出时清空；禁止写入仓库或全局 `.npmrc`。本地发布没有 CI OIDC provider，必须显式关闭 provenance。

先发布六个平台包，再发布通用启动包。以下命令均使用官方 registry 和 `preview` tag：

```bash
npm publish dist/cli-release/agentroam-runtime-darwin-arm64-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-runtime-win32-x64-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-cloudflared-darwin-arm64-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-cloudflared-win32-x64-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-tui-darwin-arm64-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/caoqu-agentroam-tui-win32-x64-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-0.2.0-preview.17.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
```

发布后复核 `preview` dist-tag，并分别在 macOS arm64 和 Windows x64 执行
`npx agentroam@preview doctor`。

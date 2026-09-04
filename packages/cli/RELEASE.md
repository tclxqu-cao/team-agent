# AgentRoam 0.2.0-preview.11 macOS / Windows CLI 发布验收

支持平台：macOS arm64、Windows 10/11 x64，运行时固定使用 Node.js 22。
全部构建和打包在 macOS arm64 完成；Windows 只下载同一批产物做实机验证，
不安装 Bun、Python、Visual Studio Build Tools，也不运行 `node-gyp`。

## macOS 打包

```bash
PATH=/path/to/node-v22/bin:$PATH npm run pack:cli:all
```

最终目录 `dist/cli-release` 包含：

- 通用启动包 `agentroam-0.2.0-preview.11.tgz`
- macOS / Windows 各自的 runtime、cloudflared 和 TUI 包
- 校验文件 `SHA256SUMS`

runtime tarball 在打包时静态校验 native 文件格式和架构：macOS 必须为
Mach-O arm64，Windows 必须为 PE32+ x86-64。Windows `better-sqlite3` 和
`node-pty` 必须命中 Node 22 ABI 127 的预编译文件，缺失时直接中止打包。

## 安装器与常驻服务

版本化 `install-agentroam.sh` / `install-agentroam.ps1` 用于首次安装、升级和
修复。安装器校验 Node 22 和精确 CLI 后，默认注册当前用户服务、启动并验证
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

## npm 发布顺序

本仓库的 npm 发布统一使用发布时提供的 access token，不走浏览器 WebAuthn。token 只能写入权限受限的临时 npm user config，发布进程退出时清空；禁止写入仓库或全局 `.npmrc`。本地发布没有 CI OIDC provider，必须显式关闭 provenance。

先发布六个平台包，再发布通用启动包。以下命令均使用官方 registry 和 `preview` tag：

```bash
npm publish dist/cli-release/agentroam-runtime-darwin-arm64-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-runtime-win32-x64-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-cloudflared-darwin-arm64-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-cloudflared-win32-x64-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-tui-darwin-arm64-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/caoqu-agentroam-tui-win32-x64-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
npm publish dist/cli-release/agentroam-0.2.0-preview.11.tgz --registry https://registry.npmjs.org --access public --tag preview --provenance=false
```

发布后复核 `preview` dist-tag，并分别在 macOS arm64 和 Windows x64 执行
`npx agentroam@preview doctor`。

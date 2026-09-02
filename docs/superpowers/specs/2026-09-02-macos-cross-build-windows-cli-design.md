# AgentRoam macOS 交叉打包 Windows CLI 设计

**日期：** 2026-09-02
**状态：** 待用户复核
**项目：** customer-agent

## 1. 目标

在 macOS arm64 开发机上生成可发布的 AgentRoam npm 包，同时支持：

- macOS arm64；
- Windows 10/11 x64；
- Node.js 22.x；
- `npx agentroam@preview` 使用同一个主包名称；
- Windows 最终用户无需 Bun、Visual Studio Build Tools 或本地源码编译。

Windows 机器只承担产物验收，不承担日常构建。发布前必须先在 Windows 安装 macOS 生成的本地 tarball 并完成真实运行验证；发布后再从官方 npm registry 空缓存安装复核。

Windows ARM64、Linux、Windows 7/8 和消费端源码编译不在本次范围内。

## 2. 当前限制

当前 `agentroam` 主包同时包含通用 CLI 和 `packages/cli/runtime`。runtime 中的 `better-sqlite3` 与 `node-pty` 由 staging 宿主机安装，并被裁剪为 `darwin-arm64`。因此当前 tarball 内的 `.node` 文件是 Mach-O arm64，不能在 Windows 加载。

仅把主包的 `os` 改为 `darwin`、`win32`，或把 `cpu` 改为 `arm64`、`x64`，只会放开 npm 安装门禁，不会产生 Windows 原生模块。同一 npm name/version 也不能发布两份内容不同的主包。

另外，当前实现还有以下平台硬编码：

- runtime 路径固定为主包内的 `../runtime`；
- `doctor` 和 `agent-tui` 入口固定解析 darwin arm64 TUI 包；
- cloudflared 安装器只接受 tgz 并调用外部 `tar`；
- CLI tarball 审计固定要求 Mach-O arm64 和 darwin node-pty 文件；
- 安装 smoke 固定执行 `/bin/zsh` 并检查 `spawn-helper`；
- `ws-server.mjs` 使用 URL pathname 计算自身目录，Windows 盘符路径不可靠；
- terminal 持久化元数据在 Windows 仍可能记录 `/bin/zsh`。

## 3. 选择的发布架构

采用“通用主包 + 完整平台 runtime 包 + 平台 cloudflared 包”的结构。

```text
agentroam
  optional -> agentroam-runtime-darwin-arm64
  optional -> agentroam-runtime-win32-x64
  optional -> agentroam-cloudflared-darwin-arm64
  optional -> agentroam-cloudflared-win32-x64
  optional -> agentroam-tui-darwin-arm64
  optional -> agentroam-tui-win32-x64
```

### 3.1 通用主包

`agentroam` 只包含：

- `bin/agentroam.mjs` 和 `bin/agent-tui.mjs`；
- 编译后的 CLI 控制逻辑；
- QR、public readiness 和 tunnel orchestration 等通用依赖；
- 目标平台到 optional package 的映射。

主包删除 `os`、`cpu` 限制，不再包含 `runtime/`，因此同一个 tarball 可安装到 macOS arm64 和 Windows x64。

启动时先调用现有 `detectPlatform()`，再通过 `createRequire(import.meta.url)` 解析对应 runtime package 导出的 runtime 根目录。平台包缺失、版本不一致或 target 不匹配时，在启动任何子进程前失败，并提示使用官方 registry 重新安装精确版本。

### 3.2 平台 runtime 包

新增：

```text
agentroam-runtime-darwin-arm64
agentroam-runtime-win32-x64
```

每个平台 runtime 包包含完整且可独立审计的：

```text
runtime/
  ws-server.mjs
  server.js
  .next/
  webapp/dist/
  node_modules/
    @agent/core/
    better-sqlite3/
    node-pty/
    ...standalone runtime dependencies
manifest.json
```

包自身声明精确 `os`、`cpu`：

```text
darwin-arm64 -> os=darwin, cpu=arm64
windows-amd64 -> os=win32, cpu=x64
```

内部 `PlatformTarget` 暂时保留现有 `windows-amd64` 值，以减少运行时代码迁移；npm 包名和 node-pty 目录使用生态标准的 `win32-x64`。两者必须通过集中映射转换，业务代码不得自行拼接名称。

manifest 至少记录 package version、内部 target、Node major、Node module ABI、关键原生文件相对路径和 SHA-256。主包运行时校验 manifest，不依赖目录命名猜测平台。

### 3.3 cloudflared 平台包

保留已有 `agentroam-cloudflared-darwin-arm64`，新增 `agentroam-cloudflared-win32-x64`。

cloudflared manifest 增加资产格式：

```ts
type AssetFormat = "tgz" | "executable";
```

- macOS 包继续携带官方 `.tgz`，校验后解压并设置执行权限；
- Windows 包直接携带官方 `cloudflared-windows-amd64.exe`，校验后复制为数据目录下的 `cloudflared.exe`；
- Windows 路径不调用外部 `tar`，也不执行 `chmod`；
- 两个平台都校验精确 upstream version、大小和 SHA-256。

### 3.4 TUI 平台包

本次沿用现有 TUI optional package 模式，新增 `agentroam-tui-win32-x64`，避免同时引入 TUI 包名迁移。两个 TUI 包使用同一份 Node ESM bundle，但分别声明平台 metadata，主包按 target 解析对应 `./entry`。

TUI 读取 Desktop SQLite 配置仍是可降级能力：`better-sqlite3` 无法加载时只显示警告，不能阻止 TUI 使用环境变量或交互式模型配置启动。

## 4. macOS 交叉组装流程

staging 脚本增加显式且必填的 `--target`，禁止从 `process.platform` 隐式决定产物。

```text
build shared assets once on macOS
  -> build webapp
  -> build core
  -> build TUI Node bundle
  -> build Next standalone

stage darwin-arm64 runtime
  -> install/copy shared JS runtime
  -> install matching native dependencies
  -> retain node-pty/prebuilds/darwin-arm64 only
  -> audit Mach-O arm64 files

stage windows-amd64 runtime
  -> install/copy the same shared JS runtime
  -> fetch better-sqlite3 for platform=win32 arch=x64 target=Node 22
  -> retain the complete node-pty/prebuilds/win32-x64 tree
  -> reject any native build fallback
  -> audit PE32+ x86-64 files
```

### 4.1 better-sqlite3

`better-sqlite3` 的 `prebuild-install` 支持 `npm_config_platform`、`npm_config_arch`、`npm_config_target` 和 `npm_config_runtime`。Windows staging 在隔离目录中固定：

```text
npm_config_platform=win32
npm_config_arch=x64
npm_config_target=<pinned Node 22 version>
npm_config_runtime=node
```

构建必须观察到已下载的预编译文件。任何 `node-gyp rebuild`、本地编译或缺少匹配 prebuild 都直接失败，不能把 macOS 二进制或源码编译结果混入 Windows 包。

### 4.2 node-pty

`node-pty@1.1.0` 的 npm 包已经携带 `prebuilds/win32-x64`。Windows staging 不运行其基于 `process.platform` 的宿主机选择逻辑，而是从已校验的 npm 包内容复制并保留完整目标目录，至少包含：

- `conpty.node`；
- `conpty_console_list.node`；
- `pty.node`；
- `conpty/conpty.dll`；
- `conpty/OpenConsole.exe`；
- `winpty-agent.exe` 和 `winpty.dll`。

不得沿用当前无条件删除 `third_party/conpty` 后只保留 darwin prebuild 的逻辑。最终以 Windows ConPTY smoke 判断文件集合是否完整。

### 4.3 静态原生审计

macOS 无法执行 Windows `.node` 和 `.exe`，只能做静态门禁：

- 文件存在且大小非零；
- DOS `MZ` 和 PE header 有效；
- machine 为 x86-64 (`0x8664`)；
- runtime manifest 声明 Node 22 和预期 module ABI；
- Windows runtime 不包含 Mach-O、darwin node-pty prebuild 或 macOS cloudflared；
- macOS runtime 不包含 Windows PE 文件和 win32 node-pty prebuild。

静态审计不能替代 Windows `require()` 和 PTY 运行验证。

## 5. Windows 运行兼容

### 5.1 runtime 与路径

- 使用 `fileURLToPath(import.meta.url)` 计算 `ws-server.mjs` 所在目录，避免 `/C:/...` 路径；
- root 列表继续使用 `path.delimiter`；
- 所有路径拼接继续使用 Node `path` API；
- 绝对文件交付物路径识别需接受盘符路径，并拒绝 NUL、CR、LF；
- runtime package resolver 必须返回 canonical absolute path。

### 5.2 PowerShell 与 ConPTY

Windows 默认 shell 顺序为：

1. PATH 中的 `pwsh.exe`；
2. Windows PowerShell `powershell.exe`；
3. 明确失败并提示安装可用 PowerShell。

不能把 `cmd.exe` 当作 PowerShell 并传入 `-NoLogo` 或 `-Command`。terminal tab 保存的 shell 字段必须与实际启动 shell 一致。

PowerShell prompt integration 继续通过 OSC 7 上报 cwd。历史集成作为增强项保留正常 PSReadLine 行为；历史 hook 安装失败不能阻止终端启动。

### 5.3 子进程清理

Windows 继续使用 `taskkill /PID <pid> /T /F` 清理 server、cloudflared 和 relay 子进程树。测试覆盖：

- 重复 close 幂等；
- 子进程已退出；
- `taskkill` 不可用时回退 `child.kill()`；
- Ctrl+C 后端口释放且没有遗留 cloudflared。

## 6. 构建命令与产物

根脚本提供目标明确的命令，不再把版本号和平台写死在多个脚本中：

```text
npm run build:cli:shared
npm run pack:cli:darwin-arm64
npm run pack:cli:windows-amd64
npm run pack:cli:all
npm run verify:cli:static
```

所有 package version 从单一 release metadata 或各 package JSON 读取。审计脚本从被审计 tarball 的 package JSON 和 manifest 推导预期文件名，不硬编码 `preview.6`。

macOS 构建输出至少包括：

```text
agentroam-<version>.tgz
agentroam-runtime-darwin-arm64-<version>.tgz
agentroam-runtime-win32-x64-<version>.tgz
agentroam-cloudflared-darwin-arm64-<version>.tgz
agentroam-cloudflared-win32-x64-<version>.tgz
agentroam-tui-darwin-arm64-<version>.tgz
agentroam-tui-win32-x64-<version>.tgz
checksums.txt
```

## 7. Windows 验证流程

### 7.1 发布前 tarball 验证

将 macOS 生成的 Windows 相关 tarball 和通用主包传到 Windows 10/11 x64、Node 22 环境，在全新临时目录执行：

1. `npm init -y`；
2. 从本地 tarball 安装主包、Windows runtime、Windows cloudflared 和 Windows TUI；
3. `agentroam version`；
4. `agentroam doctor`，真实加载 `better-sqlite3` 和 `node-pty`；
5. SQLite 建库、写入、读取 smoke；
6. PowerShell ConPTY 执行 `Write-Output agentroam-pty-ok`；
7. `agentroam start --local-only --no-qr`；
8. 请求 `/api/web-auth/status` 和 `/app/`；
9. 校验 LAN pairing URL；
10. Ctrl+C 后确认端口释放且没有遗留进程。

任一步失败都禁止发布该版本。

### 7.2 发布后 registry 验证

平台包先发布，主包最后发布。npm automated validation 完成并且 packument 可见后，在 Windows 使用独立空 npm cache 执行：

```text
npx agentroam@preview doctor
npx agentroam@preview --local-only --no-qr
agent-tui
```

同时确认 npm 只安装 `win32-x64` optional packages，没有下载 darwin 平台包。registry 产物的 SHA-256 必须与发布前 Windows 已验证的本地 tarball 一致。

## 8. 测试范围

### 8.1 单元测试

- target 到 runtime、cloudflared、TUI 包名的映射；
- 缺包、版本不一致、manifest target 不一致；
- cloudflared `tgz` 与 `executable` 两种安装格式；
- Windows `.exe` 目标路径和 PATH 查找；
- runtime path resolution；
- PowerShell shell 选择和 terminal 元数据；
- Windows taskkill 清理；
- Windows 盘符绝对路径识别；
- 动态版本和平台 tarball 审计。

### 8.2 macOS 构建测试

- shared build 只执行一次；
- 两个平台 runtime 都能由同一 shared build 组装；
- better-sqlite3 Windows prebuild 下载失败时 fail closed；
- node-pty Windows 目录完整性；
- Mach-O/PE 架构静态审计；
- 主包不再泄漏任何 native runtime；
- 所有 tarball 严格 files allowlist 和大小门禁。

### 8.3 Windows 真实测试

Windows 的 native require、SQLite、ConPTY、PowerShell、Next/WebSocket server、文件访问和进程树清理必须在真实 Windows x64 上执行。macOS mock 测试不能替代这些验收。

## 9. 发布与失败处理

发布顺序：

1. 两个平台 runtime 包；
2. 两个平台 cloudflared 包；
3. 两个平台 TUI 包；
4. 通用 `agentroam` 主包。

主包发布前，所有精确版本的 optional packages 必须已经通过 npm 自动审核并能从官方 registry 获取。Windows 发布前 smoke 必须使用本次待发布的确切 tarball，不能使用旧缓存或重新打包后的文件。

npm 版本不可覆盖。发布后 Windows registry smoke 如果发现问题，只能停止推进 dist-tag 并发布递增的 prerelease 版本；不得重复 publish 同一版本。

## 10. 验收标准

- 所有 npm tarball均由 macOS arm64 主机构建和组装；
- Windows runtime 仅包含 PE32+ x86-64 原生文件，不包含 Mach-O；
- Windows 用户不需要 Bun、Python、Visual Studio 或 node-gyp；
- `npx agentroam@preview` 在 Windows 10/11 x64、Node 22 上完成安装和启动；
- `agentroam doctor` 真实加载 Windows `better-sqlite3` 与 `node-pty`；
- PowerShell ConPTY 能执行命令并返回输出；
- 本地 Web、SQLite、文件根目录、pairing 和退出清理通过；
- cloudflared Windows 包不依赖外部 `tar`；
- 主包保持通用，npm 自动选择当前平台包；
- 发布前与发布后的 Windows 验证均使用内容一致的 tarball；
- 不支持的平台在启动子进程前返回明确错误。

## 11. 非目标

- Windows ARM64 或 Linux；
- 从 macOS 源码交叉编译 C/C++ 原生模块；
- 最终用户安装阶段回退 node-gyp；
- Windows 服务、后台守护进程或自动启动；
- 为没有官方 prebuild 的未来依赖提供通用交叉编译工具链；
- 在本次改造中改变 relay provider 顺序、认证模型或 Web UI 设计。

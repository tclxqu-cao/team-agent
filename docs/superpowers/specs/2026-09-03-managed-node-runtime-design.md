# AgentRoam 托管 Node.js 22 Runtime 设计

**日期：** 2026-09-03  
**状态：** 已实施
**项目：** customer-agent

## 1. 目标

AgentRoam 在 macOS arm64 和 Windows x64 上保证使用 Node.js 22 运行。机器完全没有 Node 时，用户通过独立安装脚本完成首次引导；机器已有 Node 但主版本不是 22 时，CLI 在加载 Server 和 native modules 前自动安装或复用 AgentRoam 私有 Node 22，并用它重新启动自身。

系统已有任意 Node 22 时直接复用，不下载、不修改、不升级用户的 Node。AgentRoam 私有 Node 初始锁定为 `22.22.0`，后续仅随 AgentRoam 发版显式升级，不在启动时追踪 `latest-v22.x`。

## 2. 当前约束与启动悖论

当前 npm launcher `packages/cli/bin/agentroam.mjs` 使用 `#!/usr/bin/env node`。机器完全没有 Node 时，该文件无法执行，因此“CLI 自己检测并安装 Node”只能覆盖已有其它 Node 版本的情况，不能覆盖零 Node 环境。

完整方案必须有两个入口：

1. 不依赖 Node 的 Shell / PowerShell 安装脚本，负责零 Node 首次引导。
2. npm launcher 的最早期 Node 版本预检，负责错误主版本自动切换。

两个入口使用相同的锁定版本、官方归档地址、SHA-256、安装目录和验证口径。

## 3. 选定架构

### 3.1 平台与版本

- macOS Apple Silicon：`node-v22.22.0-darwin-arm64.tar.xz`
- Windows 10/11 x64：`node-v22.22.0-win-x64.zip`
- 官方基址：`https://nodejs.org/dist/v22.22.0/`
- macOS SHA-256：`2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac`
- Windows SHA-256：`c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a`

Linux、macOS Intel、Windows arm64 和 WSL 不在本次托管 Node 支持范围内。现有平台检测对不支持的平台继续给出明确错误。

### 3.2 目录

私有 Node 安装到：

```text
<dataDir>/runtimes/node/22.22.0
```

默认 `dataDir` 为 `<homedir>/.agentroam`。归档解压到同父目录的临时目录，验证后原子 rename 到版本目录。旧版本不自动删除，新版本验证成功前不替换当前可用版本。

独立安装器把 AgentRoam 精确版本安装到：

```text
<dataDir>/launcher/<agentroam-version>
```

macOS 启动包装器写入 `~/.local/bin/agentroam`。Windows 包装器写入 `%USERPROFILE%\.agentroam\bin\agentroam.cmd`，安装器将该目录加入用户级 PATH；不修改机器级 PATH，不需要管理员权限。macOS 不自动编辑 `.zshrc`、`.zprofile` 等用户 shell 文件；`~/.local/bin` 不在 PATH 时输出可直接执行的配置提示。

### 3.3 单一版本清单

新增 CLI 内的 Node runtime manifest，包含 Node 版本、平台归档名、官方 URL、SHA-256 和归档内根目录。Node manager、安装器一致性测试、release 收集与审计都读取或校验这份清单。

Shell 和 PowerShell 源文件需要在 Node 不存在时独立运行，因此脚本内保留生成时展开的版本与 checksum。自动测试必须逐字段核对脚本与 manifest，防止发版只更新一侧。

## 4. npm CLI 自举流程

`packages/cli/bin/agentroam.mjs` 在动态导入 `dist/cli.js` 前只执行 Node preflight：

```text
agentroam entry
  -> Node major == 22: import dist/cli.js
  -> Node major != 22:
       parse --data-dir or use ~/.agentroam
       resolve cached private Node 22.22.0
       install and verify when absent
       spawn private node [current launcher, ...args]
       proxy stdio, signals and exit status
       original process exits
```

重启子进程设置 `AGENTROAM_MANAGED_NODE=22.22.0`。如果带此标记的进程仍不是 Node 22，立即报错，避免路径或归档损坏造成无限重启。

预检必须发生在 `detectPlatform()`、Server runtime 加载、`better-sqlite3` 和 `node-pty` 加载之前。由私有 Node 重新启动后，现有 `process.execPath` 自然指向私有 Node，Server child、Codex npm 安装器和 macOS service 配置都会沿用 Node 22。

### 4.1 兼容下限

错误版本自举入口只依赖 Node 18 及以上可用的 ESM、HTTPS、filesystem 和 child process API。Node 18 以下不尝试在复杂兼容环境中下载，直接输出独立安装脚本命令；零 Node 和旧 Node 都能通过同一个外部安装器恢复。

## 5. 独立安装器流程

源文件：

- `packages/cli/install/install-agentroam.sh`
- `packages/cli/install/install-agentroam.ps1`

release 收集后同时存在于：

- `dist/cli-release/install-agentroam.sh`
- `dist/cli-release/install-agentroam.ps1`

发布时作为对应 Gitee Release 的版本化附件，文档只展示版本固定的 Release URL，不执行 `master/raw` 下的可变脚本。

安装器执行：

1. 检测当前平台与 CPU，拒绝非 macOS arm64 / Windows x64。
2. 解析 `AGENTROAM_DATA_DIR`，未设置时使用默认数据目录。
3. 如果系统 Node 主版本为 22，复用系统 Node；否则确保私有 Node `22.22.0` 已安装。
4. 使用官方 Node 归档固定 URL下载，校验 SHA-256。
5. 在临时目录解压，执行 `node --version` 并确认精确为 `v22.22.0`，再原子激活。
6. 用选中的 Node 直接运行其 `npm-cli.js`，从 `https://registry.npmjs.org` 安装与安装器 Release 相同的精确 AgentRoam 版本。
7. 验证 launcher 可执行 `version` 和 `doctor`，然后原子写入启动包装器。
8. 输出包装器路径与 PATH 状态。

安装器不调用系统包管理器，不安装到 `/usr/local`、`Program Files`，不覆盖全局 npm 包，也不删除用户已有 Node。

## 6. 下载、锁与验证

Node manager 使用 `<version>.lock` 独占文件避免并发下载。锁等待窗口覆盖完整下载超时，锁 mtime 超过下载上限后才允许恢复。另一个进程完成安装后，等待者重新验证目标 Node 并直接复用。

安全要求：

- 只接受 manifest 中硬编码的官方 HTTPS URL和 SHA-256。
- 下载与解压目标必须位于 `<dataDir>/runtimes/node` 下。
- 所有进程调用使用参数数组；Shell / PowerShell 对用户路径逐项引用，不拼接未验证命令。
- macOS 解压只接受预期单一根目录，Windows `Expand-Archive` 后同样检查根目录。
- 验证 `node --version`、目标平台文件名和 npm CLI 文件存在。
- checksum、解压或版本验证失败时删除本次临时目录，保留所有已验证版本。

## 7. 失败处理

- 错误 Node 环境下私有 Node 安装失败：不继续启动 Server，输出网络、checksum、解压或平台错误及独立安装器命令。
- 独立安装器 Node 成功但 AgentRoam npm 安装失败：保留已验证 Node，删除未完成 launcher 临时目录，返回非零退出码。
- 包装器更新失败：保留旧包装器，不覆盖为半写入内容。
- 系统已有 Node 22 但运行平台 runtime ABI 验证失败：继续由现有 `doctor` 报告，不自动替换系统 Node 22。

## 8. 更新策略

每个 AgentRoam 版本锁定一个 Node 22 patch。CLI 发版提升 manifest 版本后：

- 系统仍有任意 Node 22时继续复用系统 Node。
- 依赖私有 Node 的用户在首次启动新 AgentRoam 时安装新的版本目录。
- 新版本验证成功前保留旧 Node 与旧 launcher。
- 启动时不访问 `latest-v22.x`，不自动清理旧版本。

独立安装器本身绑定 Gitee Release 和精确 AgentRoam npm 版本；历史安装器始终可重复安装当时版本，不随 `preview` tag 漂移。

## 9. 测试与验收

### 9.1 单元测试

- Node 22 直接继续；Node 18/20/24/25 进入托管重启。
- manifest 的 URL、版本、SHA-256 和目标路径。
- 缓存复用、首次安装、checksum 拒绝、归档结构拒绝、版本拒绝。
- 并发安装只下载一次、旧锁恢复、失败清理。
- `--data-dir` 在 launcher preflight 阶段生效。
- 重启环境标记、stdio、signal 和退出码传递。
- Shell / PowerShell 内嵌版本与 manifest、CLI `package.json` 版本一致。
- release 收集目录与 SHA256SUMS 包含两个安装器。

### 9.2 构建和真实验证

- Node 22 下 CLI、Server、Desktop TypeScript 检查和全量 Vitest。
- macOS arm64 使用临时 HOME/PATH，在没有可发现 Node 的 shell 环境中运行安装器，验证私有 Node、私有 AgentRoam、wrapper、doctor 和本地 Server。
- Node 24/25 直接运行 npm launcher，验证自动切换后 Server 的 `process.versions.node` 为 22。
- Windows x64 CI 使用临时用户目录运行 PowerShell 安装器，验证 ZIP checksum、解压、用户 PATH wrapper 和 ConPTY/SQLite runtime。
- Gitee Release 附件名称、checksum 与文档命令一致。

macOS 开发机不能替代 Windows 用户 PATH、PowerShell 执行策略和文件锁实机行为；Windows CI 或实机验证未完成时必须明确报告剩余风险。

## 10. 非目标

- 不修改、卸载或升级用户系统 Node。
- 不安装 nvm、fnm、Volta、Homebrew、winget 或 Chocolatey。
- 不支持 Linux、WSL、macOS Intel 或 Windows arm64 的托管 Node。
- 不追踪 Node `latest` 或 `latest-v22.x`。
- 不在本次实现 AgentRoam 自身的后台静默更新服务。

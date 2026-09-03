# AgentRoam 跨平台 Codex Runtime 托管设计

**日期：** 2026-09-03  
**状态：** 已批准，待实施  
**项目：** customer-agent

## 1. 目标

AgentRoam 在 macOS arm64 和 Windows x64 上自行确保存在与当前版本兼容的 Codex CLI runtime。用户只安装 Codex Desktop 而没有全局 `codex` 命令时，AgentRoam 仍能发现、读取、实时跟随和续跑 Desktop 的本地会话。

同时修复 Windows 原生会话的跨盘项目归组、`CODEX_HOME` 解析和外部运行态判定，不改变 macOS 现有 `lsof` 占用检测语义。

## 2. 背景与根因

AgentRoam 当前通过 `CodexAppServerClient` 执行 `codex app-server --stdio`，再使用 `thread/list`、`thread/read`、`thread/resume` 和 `turn/start` 操作原生会话。Windows Codex Desktop 与 Codex CLI 是独立安装入口；仅安装 Desktop 时，系统 PATH 通常没有 `codex` 命令，导致 app-server 无法启动，所有 Codex 会话都无法枚举。

另外存在三个 Windows 兼容缺口：

- 项目归属用大小写敏感字符串比较 native `cwd` 和注册项目根，`D:\Repo` 与 `d:\repo` 会被误判为不同路径。
- Codex session root 固定为 `homedir()/.codex/sessions`，没有遵循 `CODEX_HOME`。
- 外部 writer 检测无条件执行 `lsof`，Windows 上会退化为空结果。

## 3. 选定方案

在 `packages/cli` 实现 AgentRoam 私有 Codex runtime manager，使用“显式覆盖 → 兼容的系统 CLI → 兼容的私有 runtime → 安装锁定版本”的解析顺序。

### 3.1 Runtime 解析顺序

1. `AGENT_CODEX_BIN` 显式绝对路径，必须存在且通过版本检查。
2. PATH 中用户已安装的 `codex`，版本与 AgentRoam 锁定版本兼容时直接复用。
3. AgentRoam 私有目录中的目标版本。
4. 以上都不可用时，从官方 npm registry 安装 AgentRoam 锁定的 `@openai/codex` 版本。

用户的全局 Codex CLI 只读检查，AgentRoam 不对它执行 `npm update`、覆盖或卸载。全局版本不兼容时，转而安装和使用私有 runtime。

本设计中“兼容”指 `codex --version` 解析出的版本与 AgentRoam 锁定版本完全相同。不使用 semver 范围自动接受更新的 `0.x` 版本，因为 app-server 实验协议可能随 minor 版本改变。

### 3.2 版本策略

Codex 版本由 CLI 项目中的单一常量锁定，初始为 `0.153.0`。AgentRoam 版本升级时显式更新该常量和对应测试；启动时不查询或追随 npm `latest`。

私有 runtime 路径包含版本号，例如 `<dataDir>/runtimes/codex/0.153.0`。目标版本不存在时才安装；AgentRoam 后续提升锁定版本后，新版本首次启动自动安装到新目录。旧版本在新版本安装和验证成功前保留，避免更新中断破坏已有 runtime。

### 3.3 安装与并发安全

- 使用 AgentRoam 当前 Node/npm 环境安装官方 `@openai/codex@<locked-version>` 及当前平台 optional package。
- npm 执行器优先使用 `process.env.npm_execpath` 并由 `process.execPath` 启动，以复用当前 `npm` / `npx` 环境；其次使用 PATH 中的 `npm`（Windows 为 `npm.cmd`）。两者都不可用时返回明确的安装器不可用错误。
- 安装先写入同父目录下的临时目录，完成后验证 native binary 目标平台、`codex --version` 和 `app-server` 能力，最后原子切换。
- 用锁文件与超时处理防止两个 AgentRoam 进程同时安装。锁所有者崩溃后，超时的旧锁可恢复。
- 安装失败时，如果另一进程已完成并验证同一锁定版本，继续使用该 runtime；否则只将 Codex runtime 标记为 unavailable，AgentRoam 其余功能继续启动。不回退到不同版本。
- 不在每次启动时访问 npm registry。目标版本已安装时只执行本地快速验证。

### 3.4 平台产物

runtime manager 从官方 npm 包解析 native binary：

- macOS arm64：`vendor/aarch64-apple-darwin/bin/codex`。
- Windows x64：对应官方 win32-x64 optional package 内的 `codex.exe`。

实际绝对路径写入子进程的 `AGENT_CODEX_BIN`。Server 和 Desktop 保持现有 app-server JSON-RPC 协议，不引入第二套会话解析器。

## 4. 会话数据目录

Codex home 按以下顺序解析：

1. 非空 `CODEX_HOME`。
2. `join(homedir(), ".codex")`。

session root 统一为 `<codexHome>/sessions`。runtime manager 不覆盖用户已设置的 `CODEX_HOME`，保证 AgentRoam 的私有 CLI 与 Codex Desktop 读取同一份配置、认证和会话数据。

原生 Windows 与 WSL 为两套独立用户目录和进程环境。本次支持原生 Windows Codex Desktop 会话，不自动扫描 WSL 内部的 `.codex`。

## 5. Windows 项目归组

抽取可测试的平台路径归一化函数：

- macOS/Linux 保持现有 `resolve()` 和大小写敏感比较。
- Windows 使用 `path.win32.resolve()`，统一分隔符、去除非根目录末尾分隔符，并以大小写不敏感形式比较。
- 继续采用“最长已注册项目根”规则，保证嵌套项目归组不变。
- 必须按路径边界判断子目录，不允许 `D:\repo-old` 误命中 `D:\repo`。

## 6. Windows 外部运行态与占用

macOS 继续使用现有 `lsof` 打开句柄作为 writer 占用真相源，不修改其命令、过滤、PID 排除或 `idleAfterMs` 语义。

Windows 不调用 `lsof`，使用两层保护：

1. 读取 thread 对应 rollout 的最新生命周期事件。正在执行的外部 thread 投影为 `running / owned-externally / canResume=false`，保持只读实时跟随。
2. 静止 thread 允许尝试 resume，但 Codex app-server writer lock 是最终权威。如果原 Desktop 仍持有 writer，`SESSION_OCCUPIED` 会转换为只读状态，不会产生双 writer。

本次不引入 Sysinternals `handle.exe`、管理员权限、Windows Restart Manager 或 NT handle 枚举。这些方案部署依赖或实现复杂度过高，而 app-server writer lock 已能保证写入安全。

## 7. 启动流程

```text
agentroam start
  -> resolve compatible global Codex runtime
  -> resolve compatible managed Codex runtime
  -> install locked version when neither is available
  -> validate native binary and app-server capability
  -> set AGENT_CODEX_BIN for the Server child
  -> Server starts native runtime broker
  -> codex app-server lists Desktop sessions from CODEX_HOME
  -> associate native cwd with registered projects
```

Codex 安装是 AgentRoam 启动的可降级步骤。安装过程应输出明确进度；网络失败后 Server 仍可启动，runtime health 需返回可操作错误，而不是让整个 AgentRoam 退出。

## 8. 安全与失败处理

- 所有安装目标必须位于 AgentRoam `dataDir` 下，不接受 npm 包输出的任意路径。
- 只安装硬编码的官方包名和锁定版本，不把用户输入拼接到 shell 命令。
- 使用 `spawn` / `execFile` 参数数组，不使用 shell 字符串。
- 不删除用户全局 CLI、`.codex` 数据或任何 Desktop 会话。
- 私有 runtime 清理只针对经校验的具体版本目录，本次不自动删除旧版本。
- runtime 错误应区分“找不到”、“版本不兼容”、“下载失败”和“app-server 验证失败”。

## 9. 验证

### 9.1 单元测试

- runtime 解析顺序：显式路径、系统 CLI、私有 runtime、首次安装。
- 相同目标版本不访问 registry，锁定版本变化后安装新目录。
- 安装失败保留已验证的旧 runtime，无可用 runtime 时返回可降级错误。
- 并发启动只执行一次安装，临时目录不会被当作已完成 runtime。
- macOS 与 Windows 解析正确的官方 native binary 相对路径。
- Windows 路径大小写、盘符、子目录和边界误命中；macOS 测试锁定原大小写敏感语义。
- `CODEX_HOME` 和默认 home 目录解析。
- Windows 不调用 `lsof`，macOS 仍执行现有命令并保持输出解析。
- Windows rollout 运行态与 `SESSION_OCCUPIED` 降级。

### 9.2 构建与产物验证

- CLI、Server 和 Desktop TypeScript 检查。
- WebApp 与 Server 生产构建。
- macOS arm64 实际安装私有 runtime，验证 `codex --version`、`app-server --stdio` 及 Desktop 会话枚举。
- Windows runtime 包静态审计不内置 Codex，Codex 只出现在用户数据目录的按需安装中。
- Windows 10/11 x64 实机最终验证：只安装 Codex Desktop 与 AgentRoam，首次启动自动安装私有 runtime，能在 `D:` 盘项目下发现 `C:` 盘 `.codex` 会话，并在 Desktop 运行时无刷新跟随消息。

macOS 开发机无法替代 Windows 的真实进程、盘符和 Desktop 会话验收；在 Windows 实机验证前，交付结论必须明确标注该剩余风险。

## 10. 非目标

- 不直接复用 Windows Store / MSIX 内部的 Codex Desktop 可执行文件。
- 不修改或自动升级用户全局 Codex CLI。
- 不追随 npm `latest`，不在每次启动时执行网络版本检查。
- 不自动发现 WSL 内部的 Codex 会话。
- 不新增第二套 Codex JSONL 历史解析器。
- 不为 Windows 引入管理员权限或第三方进程句柄工具。

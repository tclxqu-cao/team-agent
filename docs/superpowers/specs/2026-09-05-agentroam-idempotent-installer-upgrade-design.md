# AgentRoam 安装器幂等升级设计

## 背景

AgentRoam 版本化 Shell 和 PowerShell 安装器同时承担首次安装、升级和修复。已安装 `0.2.0-preview.9` 的 macOS 用户直接运行 `0.2.0-preview.10` 安装器时，新 CLI 完成安装和自检后，`launchctl bootstrap` 报 `Bootstrap failed: 5: Input/output error`。

当前 macOS 控制器会在已加载任务上调用 `bootout`，但随后立即替换 plist 并重新 `bootstrap`，没有等待旧进程退出或 launchd 完成移除任务。Windows 控制器则使用 `Register-ScheduledTask -Force` 直接替换任务，已运行的旧进程可继续持有旧版本路径。

## 目标

- 重复运行安装器时自动识别并替换已有 AgentRoam 当前用户服务。
- 替换前等待旧服务进程实际退出，避免新旧服务并存或重注册竞态。
- 保留数据目录中的会话、配置、日志、配对信息和托管运行时。
- 首次安装、日常 `start|stop|restart|uninstall` 的对外语义保持不变。
- 修复验收后统一升级为 `0.2.0-preview.11`，构建并发布六个平台包和一个通用启动包，再推送 Git 提交与 Tag。

## 方案

幂等替换由平台服务控制器负责，安装器仍只调用一次 `agentroam service install`。不在 Shell/PowerShell 安装器中先调用旧 CLI 的 `service uninstall`，避免把兼容性与平台状态管理分散到两层。

### macOS LaunchAgent

1. 先验证新配置并生成、校验临时 plist，确保停服务前新定义已可用。
2. 读取现有服务配置和运行状态，保留旧 PID 作为退出判据。
3. 若 `gui/<uid>/com.agentroam.service` 已加载，执行 `launchctl bootout`。
4. 有旧 PID 时等待进程退出；无可信 PID 时轮询 `launchctl print`，直到任务不再存在。超时则中止升级，不进入新 `bootstrap`。
5. 原子替换 plist 和服务配置，清理仅属于运行态的 state/URL 文件，然后执行 `bootstrap` 并等待 ready。

不删除数据目录、日志、旧的版本化 launcher 或托管运行时。`bootstrap` 失败时保留新 plist 和配置供排查，错误信息包含实际 `launchctl` 输出；不自动回滚到旧 launcher，避免恢复一组未验证的跨版本配置。

### Windows Task Scheduler

1. 注册新任务前检查 `AgentRoam` 当前用户计划任务。
2. 若任务正在运行，先停止任务并等待状态文件中的旧 PID 退出。
3. 注销已有任务，再写入新配置、注册和启动新任务。
4. 任务不存在时按首次安装路径执行。

Windows 同样只移除计划任务注册和短期运行状态，不删除数据与日志。

## 错误处理

- 旧进程在 15 秒内未退出时中止安装，显示 PID 和平台操作错误，不强制 kill 用户进程。
- 旧任务无法注销时中止，不通过强制 kill、`sudo` 或管理员提权绕过。
- 新服务未在 ready 窗口内启动时，保留现有日志并指向 `agentroam service logs`。
- 任何失败都不删除应用数据、配对状态或托管运行时。

## 验证

- macOS 单元测试覆盖首次安装、已加载服务重装、旧 PID 延迟退出、无 state PID 时等待 launchd 任务消失、退出超时和数据保留。
- Windows 单元测试覆盖已运行任务的 stop → wait → unregister → register → start 顺序，以及已停止任务和首次安装。
- CLI 服务、安装器合约、构建和 tarball 审计全部通过。
- 用隔离 HOME 在 macOS 连续运行同一安装器两次，确认第二次完成服务替换，且预先写入数据目录的标记文件保留。
- Windows 实机验收由现有 CI runner 对同一批 macOS 构建产物执行，不以 macOS 静态审计代替。

## 发布流程

1. 将七个包、安装器、文档和验证脚本的版本统一升级到 `0.2.0-preview.11`。
2. 在 Node 22 下生成 `dist/cli-release`，验证 `SHA256SUMS`、tarball 白名单、macOS 安装/服务重装 smoke 和 Windows CI。
3. 从 macOS 钥匙串 `com.agentroam.npm-token` 取得凭据，只写入权限为 `600` 的临时 npm user config。
4. 使用官方 registry、`preview` tag、`--access public --provenance=false` 先发布六个平台包，最后发布 `agentroam`。
5. 等待 npm packument 完成索引，核对七个 `preview` dist-tag、registry tarball SHA-256 和官方 registry 全新安装。
6. 只提交本次源码、测试、版本与发布文档，排除现有 `.next*`、rollback 目录、`.claude/worktrees` 和其它用户产物。
7. 推送 `master`，创建并推送 `v0.2.0-preview.11` Tag，然后发布对应 Gitee Release 安装器与校验文件。

## 回滚

npm 版本不可覆盖或删除；若 `preview.11` 验收失败，将七个包的 `preview` dist-tag 恢复到 `0.2.0-preview.10`，保留失败版本供审计。Git 使用修复提交回退，不改写已推送历史；Gitee Release 标记为不推荐使用，不伪装成未发布。

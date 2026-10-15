# AgentRoam 启动恢复实施计划

> **For the main agent:** Implement directly in this session without subagents. Run affected unit tests after all changes are complete.

**Goal:** 让安装和启动自行处理旧 discovery PID 复用，并只在服务实际就绪后报告成功。

**Architecture:** CLI 对不可达旧记录继续核验两次进程身份，确认 PID 属于无关进程后将原记录备份到 registry/stale。服务控制器等待有效 ready 状态；命令层对超时或停止状态返回失败，安装器保留明确的错误与恢复入口。

**Tech Stack:** TypeScript、Node.js、Vitest、POSIX sh、PowerShell。

## Global Constraints

- 保留应用数据、旧记录备份、无关 worktree 修改及正在运行的官方 Codex Desktop。
- 无法确定旧进程身份时继续拒绝接管，不凭 PID 杀进程。
- 不修改项目 docs，不提交、不推送、不发布 npm；修复尚未进入公共 preview。
- 不重复应用本机 workaround 或重新启动现有健康服务。

## Task 1: 隔离 PID 已复用的旧记录

**Files:** `packages/cli/src/instance-takeover.ts`、对应 `.test.ts`。

- [x] 身份请求失败后，仅当 `alive(pid)` 为真时查询当前进程命令；命令为空、未知或指向 `ws-server.mjs` / `agentroam/bin/agentroam.mjs` 时仍报无法核验。
- [x] 对无关进程再次查询 PID、ppid、command，复核原记录内容未变化，然后 `rename(recordPath, join(registry, "stale", uniqueName))`。
- [x] 补充 PID 复用自动恢复、备份内容保留、无信号发送、进程查询失败和身份变化保护测试。

## Task 2: 服务 ready 才报告成功

**Files:** `packages/cli/src/service/{macos-launch-agent,windows-task-service,service-command}.ts` 及对应测试。

- [x] 已处于 running 的任务仍等待 ready，不直接返回 starting / stopped 旧状态。
- [x] macOS 验证 ready 状态 PID 与当前 launchd PID 一致；Windows 验证状态 PID 存活、任务仍运行。重启时拒绝 previousPid 的旧 ready 状态。
- [x] install/start/restart 的状态为空、非 ready 或没有 accessUrl 时抛出带 `agentroam service logs` 的错误。
- [x] 安装失败时不启动 Desktop setup、不生成配对码；成功时保持 setup 后生成新配对码的顺序。
- [x] 补充运行态等待、旧 ready 失效、未 ready 不打印成功及不执行 setup / pairing 的回归用例。

## Task 3: 安装脚本失败反馈

**Files:** `packages/cli/install/install-agentroam.{sh,ps1}`、`packages/cli/src/install-script-contract.test.ts`。

- [x] sh 与 PowerShell 对 service install 非零退出明确显示 CLI 已安装但后台服务未就绪，以及日志/重试命令；不继续打印总体成功或提示桌面下载。
- [x] 执行实际 sh 片段的 fake CLI 测试，断言失败退出与输出；保留无人值守跳过服务和兼容旧包路径。

## Final Unit Test Verification

- [x] `/opt/homebrew/opt/node@22/bin/node node_modules/vitest/vitest.mjs run packages/cli/src/instance-takeover.test.ts packages/cli/src/service/macos-launch-agent.test.ts packages/cli/src/service/windows-task-service.test.ts packages/cli/src/service/service-command.test.ts packages/cli/src/install-script-contract.test.ts`
- [x] `/opt/homebrew/opt/node@22/bin/node node_modules/typescript/bin/tsc -p packages/cli/tsconfig.build.json --noEmit`
- [x] `sh -n packages/cli/install/install-agentroam.sh` 与 `git diff --check`。

验证记录：共享工作区 CLI 回归 314 项通过、1 项 Windows 专属跳过。工作区另一项并行远程桌面授权开发引入独立类型错误，因此本次修复另用基线加修复的隔离快照完成 TypeScript 编译与 CLI 回归。sh 语法、安装 manifest 一致性和 diff 空白检查通过。未提交、推送或发布。

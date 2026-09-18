# 全局日志采集(Global Logging)

按天存放的全局错误日志:所有进程、所有环节的报错严格落盘到 NDJSON 文件,一个地方收口实现,其他地方只做调用。

## 实现(DDD 分层)

- **唯一实现(core 基础设施层)**:`packages/core/src/infrastructure/logger/DailyFileLogger.ts`
  - `DailyFileLogger`:NDJSON 按天文件 `<dir>/YYYY-MM-DD.log`,每行一条 `{ts, level, source, message, error?, data?}`;本地日期跨天滚动、保留 30 天自动清理、写失败永不抛出(计数 + stderr 报告一次)、fatal 级同步落盘、超长行截断。
  - `installGlobalLogging(options)`:**进程唯一装配点**(绑定目录 + 安装 uncaughtException/unhandledRejection handler + 镜像 console.error/warn)。每个进程入口只调用这一行。
  - `logGlobal(level, source, message, error?, data?)`:**业务代码唯一调用入口**(按 source 缓存子视图,未装配时静默 no-op,测试环境安全)。
  - `serverLogger()`(server 包)/ `getGlobalLogger()`:取回实例做批量/child 操作。
- 导出统一走 `@agent/core`(`src/infrastructure/index.ts`)。

## 各进程接入点与日志位置

| 进程 | 装配点 | 日志目录 |
| :--- | :--- | :--- |
| server(ws-server / 纯 next) | `packages/server/ws-server.mjs` 启动;`packages/server/lib/global-logger.ts` 兜底 | `<AGENT_DATA_DIR>/.agent-data/logs/` |
| desktop(Electron 主进程) | `packages/desktop/main/index.ts` | `<userData>/logs/` |
| tui | `packages/tui/src/main.tsx` startTui | `~/.customer-agent-tui/logs/` |
| cli | `packages/cli/src/cli.ts`(`src/error-log.ts` 自包含实现,launcher 不依赖 @agent/core,格式与 core 一致) | `<dataDir>/logs/` |
| webapp / 移动端(浏览器) | `packages/webapp/src/infrastructure/client-error-reporter.ts` → 批量 POST `/api/client-logs` | 落到 server 日志(source=webapp) |
| desktop 渲染层 | `packages/desktop/renderer/main.tsx` → preload `clientLogApi.report` → 主进程落盘 | 落到 desktop 日志 |

安装进程错误 handler 的语义:`uncaughtException` 记 fatal 后默认按 Node 原语义退出(1);长驻 UI 进程(server、desktop)传 `handlers: { exitOnUncaughtException: false }` 记录后继续运行;`unhandledRejection` 一律记 error 不退出。console.error/warn 被镜像进文件(原输出保留);console.log 不采集。

## 覆盖的报错环节

- **自有 AgentLoop(server AgentHost)**:error 事件、loop 抛错、无终态结束、构建失败、isError 工具结果(warn)、子代理失败。
- **原生 agent 适配层(desktop `main/agent-runtime/`)**:codex/claude/opencode 三个适配器的 run 失败(yield error 事件处同步 `logGlobal("error", ...)`)、codex app-server 子进程 error/exit、opencode server 子进程 error、broker 的 run 失败/无终态/目标队列失败;availability 探测失败记 info。
- **server run 路由**:native 订阅失败、run 请求失败、completion 失败。
- **ws-server**:HTTP handler 500 兜底、WS handleMessage 失败、文件 watcher 错误、runtime 初始化失败。
- **进程级**:所有 Node 进程的 uncaughtException / unhandledRejection;desktop 渲染进程崩溃(render-process-gone)与 preload 错误;voice-service stderr 经既有 console.warn 管道被镜像采集。
- **浏览器/移动端**:window error + unhandledrejection,批量节流上报。

## /api/client-logs(浏览器错误上报端点)

- 刻意**豁免设备配对**(无法完成配对的浏览器恰是最需要记录报错的客户端);锁定期仍被网关 423 拦截。
- 限流 60 req/min/IP,单请求最多 20 条,message ≤4000 字符,data 序列化后 ≤2000 字符;level 只接受 warn/error/fatal(其余钳为 error)。

## 排查入口

```bash
# server(开发态)
ls packages/server/.agent-data/logs/
# desktop
ls "$HOME/Library/Application Support/AgentRoam/logs/"   # macOS
# 按级别过滤当天错误
grep '"level":"error"' packages/server/.agent-data/logs/$(date +%F).log
```

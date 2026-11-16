# Codex 发送前等待优化 Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion.

**Goal:** 减少目录刷新造成的连接超时和重复扫描，保留真实消息的发送、错误与恢复行为。

**Architecture:** 在 Codex 连接客户端中给启动失败的连接方式设置五分钟退避，优先尝试仍可用的方式；可用方式也失败时仍立即尝试退避中的方式。共享会话目录的缓存期限与可见列表十五秒轮询周期对齐；发送接口不依赖目录缓存。

**Tech Stack:** TypeScript、Vitest、Codex app-server JSON-RPC、Next.js。

## Global Constraints

- 保留当前工作区其它修改，不修改项目 docs，不提交或推送。
- 不更改模型目录、会话锁、权限、历史分页、真实消息重试规则。
- 连接方式仍自动恢复：退避到期恢复原优先级，当前备用方式失败时立即尝试其它方式。
- 不中断当前原生会话；用独立只读探针对比启动与目录请求。

## Task 1: 启动失败退避

**Files:** `packages/native-runtime/src/agent-runtime/codex-app-server-client.ts`、对应 `.test.ts`。

- [x] 在启动流程记录失败方式的下一次尝试时间；成功后清除该方式记录。
- [x] 使用下面的排序，保留最后的可恢复路径：

```ts
const ready = attempts.filter(attempt => !cooling(attempt));
const deferred = attempts.filter(cooling);
for (const attempt of [...ready, ...deferred]) { /* existing startup handshake */ }
```

- [x] 验证重复刷新不会重新等待失败方式、五分钟后可以恢复共享连接、备用方式失败时仍可立即恢复其它连接。

## Task 2: 共享目录复用

**Files:** `packages/server/lib/session-catalog.ts`、对应 `.test.ts`。

- [x] 将成功目录结果保留十五秒；并发请求继续共用一个进行中的查询。
- [x] 保留失败后的下一次重试和不可变分页快照。
- [x] 验证窗口内搜索/列表复用、窗口到期后外部会话状态更新。

## Final Unit Test Verification

- [x] 主 Agent 运行 client（含 launcher 行为）、desktop transport、catalog 和 gateway 四个文件，101 项回归通过。
- [x] 原生运行时 `tsc --noEmit` 和本次 `git diff --check` 通过。
- [x] 独立只读客户端使用旧行为（退避为零）与新行为：刷新 10075ms → 89ms；首次启动分别 10110/10078ms；两个探针客户端已 dispose。
- [x] 记录实测范围与尚未重启的运行实例边界，沉淀 wiki。

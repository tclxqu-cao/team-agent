# Agent Collaboration Groups Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 支持跨 Agent 协作群、独立页签，以及群成员下方可重开的持久讨论历史。

**Architecture:** core 领域聚合管理成员、任务、依赖和终态。core 应用服务经仓储与执行端口调度；SQLite、原生 broker 和 AgentHost 为基础设施适配器。React 页面仅调用群 API，历史讨论独立保存。

**Tech Stack:** TypeScript, React, SQLite/better-sqlite3, Next.js, existing native broker, Vitest.

## Global Constraints

- 保留当前所有无关脏改动，不提交、不发布、不重启服务。
- DDD：domain 不依赖 application/infrastructure/UI；application 不依赖具体运行时或数据库。
- 同类型 Agent 允许多成员，每个讨论的成员使用独立会话。
- 群聊记录位于左侧群成员下面，浏览历史不触发执行。
- 同目录写任务串行；显式隔离目录允许并行；未知执行结果不盲目重跑。
- 不修改项目 docs；本文件与设计位于 .superpowers。

### Task 1: 领域与存储端口

**Files:** core/src/domain/collaboration/{types,CollaborationDiscussion,coordinator-protocol}.ts; core/src/application/collaboration/ports.ts.

**Interfaces:** `CollaborationRepository.getDiscussion(id): CollaborationDiscussionState | null`; `updateDiscussion(id, mutate): CollaborationDiscussionState`; `CollaborationRuntime.execute(input, onProgress): Promise<{text: string}>`.

- [x] 定义群、成员、讨论、步骤、消息、审批和结构化群主决策。
- [x] 聚合实现依赖校验、同成员互斥、共享目录互斥、最终完成约束和停止后事件抑制。
- [x] 测试循环依赖、重复完成、同类型不同身份、用户职责优先及提前完成拒绝。

关键用例：`expect(() => discussion.applyDecision({action: 'finish', ...})).toThrow()` 当仍有 queued/running 步骤。

### Task 2: 持久化与协作应用服务

**Files:** core/src/infrastructure/SQLiteCollaborationRepository.ts; core/src/application/collaboration/CollaborationService.ts.

**Interfaces:** `createGroup(input)`, `createDiscussion(groupId)`, `send(discussionId, text, messageId)`, `stop(id)`, `resume(id)`, `getDiscussion(id)`, `listDiscussions(groupId)`.

- [x] 独立保存群与讨论快照，事务更新、revision、调度 lease 和幂等消息 ID。
- [x] 服务端定时接收已持久 inbox；群主规划与成员执行独立，完成自动通知群主。
- [x] 保存执行意图与 sessionId，重启后将无法确认结果的活动尝试标记中断，保留人工继续入口。
- [x] 测试真实依赖接力、两个执行端口的隔离目录并行、失败通知、取消、历史重开及多实例 lease。

### Task 3: 运行时与 HTTP 适配

**Files:** server/lib/collaboration/{runtime,service,visibility}.ts; server/app/api/collaboration/route.ts; core/src/index.ts.

- [x] 适配器用 `agentHost.createSession/startRun/subscribe` 执行内置 Agent，原生使用 `getNativeRuntimeService().create/startRun/subscribe`，提取真实 done.finalText。
- [x] 绑定真实审批与会话，超时和取消中断对应运行，错误以成员消息保留。
- [x] HTTP 层校验输入，映射领域错误，沿用现有服务认证；讨论快照按 revision 返回。

### Task 4: 群界面、历史与页签

**Files:** desktop/renderer/components/collaboration/*; desktop/renderer/App.tsx; desktop/renderer/global.d.ts; webapp/src/infrastructure/http/agent-http-gateway.ts; webapp/src/main.tsx; server/app/web/{page.tsx,console-tabs.ts}.

- [x] AgentApi 增加单一群命令端口，HTTP 实现，桌面 sharedServiceApi 复用该实现。
- [x] 创建面板支持群主、多个同类型成员、模型和职责。
- [x] 群页面左侧成员下方显示讨论历史；右侧真实群消息、步骤、审批、成果，提供新讨论、停止、继续。
- [x] Web shell 按 groupId 打开独立页签，校验 postMessage 来源；桌面端使用共享群页签组件；手机显示可展开成员与记录栏。
- [x] 测试历史切换竞态、页签去重及不自动发送、创建序列与新建会话兼容。

## Final Unit Test Verification

- [x] Main agent: run affected unit tests after development is complete.

Run `bunx vitest run packages/core/src/domain/collaboration packages/core/src/application/collaboration packages/core/src/infrastructure/SQLiteCollaborationRepository.test.ts packages/server/lib/collaboration packages/desktop/renderer/components/collaboration`.

- [x] Run targeted TypeScript checks, core build and webapp build; isolate build output from deployed assets.
- [x] Use ego-browser against an isolated service for group creation, history location/persistence and available real runtime collaboration; report any actual unavailable-runtime or device gap separately.


验证结果与实际验收边界见设计文件末尾。本轮 WebApp 生产构建通过，完整类型检查仍被仓库已有问题阻塞，未将其标记为全量通过。

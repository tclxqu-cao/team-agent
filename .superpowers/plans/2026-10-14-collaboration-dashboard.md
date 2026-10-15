# 群看板 Implementation Plan

> **For the main agent:** Implement directly in this session without subagents. Run affected tests after implementation.

**Goal:** 群聊工具图标打开持久化群看板，支持打开历史群、新增、编辑和删除。

**Architecture:** 领域层负责群配置校验、忙碌保护、删除状态与讨论配置快照；应用层通过仓储端口完成事务；SQLite 适配器负责原子持久化；API 只做输入与宿主路径校验，React 只做展示与交互。已有讨论固定成员配置，新的配置用于新讨论。删除采用逻辑删除，保留内部会话隔离和历史数据。

**Tech Stack:** TypeScript, React, Next.js, SQLite, Vitest.

## Tasks

- [x] 添加群领域对象、更新/删除命令、事务仓储端口；测试忙碌保护、历史快照、重开持久化。
- [x] 编排器使用讨论快照；HTTP 路由接入更新/删除并复用路径校验。
- [x] 实现紧凑的响应式看板和编辑表单，包含加载、空态、错误、重试及删除确认。
- [x] 群聊工具图标打开独立看板 tab；仅信任已知同源 iframe 的群操作消息；保留默认隐藏配置。
- [x] 运行领域、应用、持久化、桥接和界面测试、类型检查与隔离构建/API CRUD 验证。
- [x] 按发布技能保护活跃会话及共享 Codex daemon，发布到 :3000 并验证线上产物/API；沉淀 wiki。

## Verification

Run affected Vitest tests with Node 22, renderer/server TypeScript checks, core/WebApp/Next production builds. Use an isolated database to verify create, reopen, edit with preserved history, busy rejection, delete and reopen. Do not mutate user groups during validation. Browser TaskSpace remains user-controlled; report UI acceptance limits honestly.


## Completed evidence

- 94 focused tests passed; Desktop/Server TypeScript checks passed.
- Core, Vite and isolated Next production builds passed.
- Isolated HTTP CRUD verified across actual process restart; legacy history and internal session isolation retained.
- Live :3000 BUILD_ID `OcvvE-2SLezLhsxFF937a`, gateway PID `18258` stable, protected Codex PID `37653` retained.
- 468 WebApp / 63 Next static files verified by SHA256; existing group and discussion payloads unchanged across release.
- Browser TaskSpace remains user-controlled; no browser/physical phone visual acceptance claimed.

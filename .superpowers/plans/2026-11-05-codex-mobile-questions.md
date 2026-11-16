# Codex Desktop 跨端问答恢复

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion.

**Goal:** 手机刷新后仍能看见同一 Codex Desktop 会话里的异步问题、选项和回答状态。

**Architecture:** 在原生适配层投影结构化问题，复用现有问答卡。增量读取 rollout 中摘要接口省略的问题，维持分页、查询索引一致。回答前重读原生问题状态，通过原生 thread/turn API 回传有问题身份的答案。

**Tech Stack:** TypeScript、现有 Codex App Server 客户端、React、Vitest。

## Constraints

- 保留无关并行改动；不修改项目 docs，不提交或推送。
- 已回答与已中断的卡片不可重复提交。
- 外部问答恢复不能依赖本端内存中的运行队列。
- 不为恢复问题读取全部工具输出；复用 rollout 的增量扫描。
- 不向真实赔付会话发送测试答案，不因回答失败创建副本。

## Implementation

- [x] 新增 `codex-questions.ts`：稳定问题身份、问题投影、持久化回答匹配及回答 envelope。
- [x] 在已有 rollout 增量扫描中保留异步问题，并合入摘要读取；core/full/query-index 使用同一问答投影。
- [x] 扩展问题展示状态为 pending，复用现有前端映射；broker 允许恢复的问题经原生适配器回答。
- [x] 回答前重读原生历史，运行中 steer，已结束回合在同一会话启动带身份的回答；失败保留可重试状态。
- [x] 补充多问题、跨回合桌面回答、摘要省略、分页、刷新去重和回答失败回归。

## Final Unit Test Verification

- [x] Main agent: run affected unit tests after development is complete.
- [x] 构建相关包，并用原会话数据只读验证移动宽度的问答卡；验证边界与运行实例更新状态分别报告。

## 验证结果

- 定向回归总计 377 项通过；最后的问答相关 14 项在去重与构建兼容调整后复验通过。
- core、native-runtime 构建通过。
- 原会话只读验证恢复 18 条 core 消息中的两张问答卡：发布确认已回答、酒店测试订单待回答。
- 当前运行时持有本会话，已启动空闲加载脚本，核对产物哈希、active run 数和 PID 后才重载；加载后自动回读原会话的两种卡片状态。最终加载结果以 `.artifacts/codex-mobile-ask-20261105/activation-status.json` 为准。

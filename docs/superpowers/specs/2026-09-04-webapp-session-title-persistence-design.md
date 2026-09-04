# WebApp 新会话首条消息标题持久化设计

**日期：** 2026-09-04  
**状态：** 待实施  
**项目：** customer-agent

## 1. 目标

WebApp 通过侧边栏手动创建的新会话，在第一条非空用户消息发送后，持久显示该消息前 60 个字符作为会话标题。运行结束刷新目录、页面刷新和 AgentRoam 进程重启后，标题保持不变。

本次只修复部署新版本后创建的会话。已有标题为“新会话”的历史记录不迁移、不回填，也不会在后续发送消息时被自动改名。

## 2. 当前问题

侧边栏创建入口先以固定标题“新会话”调用 `createSession`。第一条消息发送后，renderer 的 `onMessageSent` 只更新 React 内存中的 `sessionsByProject` 和 `otherLocalSessions`，没有写回 SQLite 或原生运行时。`onRunComplete` 随后刷新会话目录，持久标题重新覆盖乐观标题。

未选择会话而直接发送时，`prepareChatCommand` 会用第一条消息创建会话，因此不存在回退。两条创建路径的标题所有权不一致是问题根因。

## 3. 方案选择

采用 AgentRoam 持久化的“待首条消息命名”标记，不逐个依赖原生运行时的改名接口。

- Customer Agent 会话在自身 SQLite session metadata 中保存标记，首次运行前更新 `sessions.title` 并清除标记。
- Codex、Claude Code 和 OpenCode 会话由 native runtime broker 保存标记与显示标题。broker 在首次运行前原子消费标记，并在所有 summary/detail 投影中覆盖运行时返回的占位标题。
- 标题真相仅作用于 AgentRoam 的统一会话视图。本次不承诺同步修改 Codex Desktop、Claude Code CLI 或 OpenCode 客户端中的原生标题。

不采用以下方案：

1. 分别调用各运行时改名 API：Codex 有 `thread/name/set`，但 Claude Agent SDK 没有对等稳定接口，跨运行时语义无法一致。
2. 推迟到第一条消息才创建会话：需要新增未落盘草稿、待选 Agent 类型和刷新恢复状态，改动范围明显更大。

## 4. 数据模型

### 4.1 Customer Agent

创建标题精确等于系统占位值“新会话”时，在 session metadata 增加内部布尔标记。创建时已带业务标题的会话不增加标记。

首次 `run(input, sessionId)` 在保存用户消息前检查并消费标记：

- `input.trim()` 非空时，将原始输入前 60 个字符作为标题；
- 在一次 session update 中同时写入标题和清除标记；
- 消费后即使本轮失败，标题也保持第一条用户输入，不由后续消息重试改写。

Desktop 与 Web Server 的 Customer Agent host 使用相同规则，避免共享 renderer 在两端表现不同。

### 4.2 Native Runtime Broker

broker SQLite 增加专用会话标题表，至少包含：

- `session_id`：统一原生会话 ID，主键；
- `title`：AgentRoam 持久显示标题；
- `auto_title_pending`：是否等待第一条消息命名；
- `updated_at`：更新时间。

broker 创建标题为“新会话”的新会话后写入 pending 记录。首次 `startRun` 在创建活动 run 之前原子消费标记并写入输入标题。`list`、`refresh`、`get` 和 pending creation 投影统一经过 title override，页面与进程刷新不会回退。

非占位标题、旧会话和已消费记录不受影响。标题覆盖记录只由新版本创建流程产生，因此不会把历史同名会话误判为待命名会话。

## 5. 数据流

```text
侧边栏创建“新会话”
  -> CA metadata / native broker 写入 auto_title_pending
  -> renderer 显示空会话
  -> 用户发送第一条非空消息
  -> 后端在 run admission 前原子消费 pending
  -> 持久标题 = 消息前 60 字符
  -> 正常启动 run
  -> onRunComplete 刷新目录
  -> session summary 返回持久标题
```

renderer 仍可保留即时乐观标题，作为网络往返期间的体验优化，但它不再承担持久化职责。

## 6. 并发与失败处理

- 标记消费必须使用条件更新或同等原子操作，两个并发 start 请求只能有一个成功命名。
- 标题写入发生在 run admission 前；写入失败时拒绝启动该轮，避免用户消息已执行但标题状态仍悬空。
- 空白输入不消费标记，也不产生空标题。
- 标题截断沿用现有 renderer 语义：原始输入前 60 个 JavaScript 字符，不另做摘要生成。
- broker summary 覆盖只替换 `title`，不得改变 cwd、projectId、occupancy、permission mode 或目标状态。

## 7. 测试与验收

### 7.1 单元测试

- CA 新占位会话首次运行前写入消息标题并清除标记。
- CA 带业务标题创建时不自动改名。
- CA 已消费或无标记的历史“新会话”不被后续消息改名。
- native broker 新占位会话首次 startRun 后，list/refresh/get 均返回消息标题。
- native broker 状态重建后仍返回持久标题。
- Codex、Claude Code、OpenCode 共用同一 broker 标题规则。
- 并发或重复 startRun 不用第二条消息覆盖标题。
- Web API 与 gateway 保持现有请求契约，不增加前端专用改名请求。

### 7.2 回归验证

- 运行 native broker、UnifiedSessionService、Server sessions API、CA host 和 renderer 相关测试。
- 执行 Desktop、Server、WebApp TypeScript 检查。
- 执行 `git diff --check`。
- 实页创建 CA、Codex、Claude Code、OpenCode 新会话，各发送一条消息；等待运行结束刷新目录，再刷新页面，确认标题不回退。

## 8. 非目标

- 不修改已有“新会话”历史记录。
- 不批量读取历史第一条消息。
- 不新增手工重命名 UI。
- 不保证 AgentRoam 标题同步到外部原生客户端。
- 不用模型生成标题摘要。

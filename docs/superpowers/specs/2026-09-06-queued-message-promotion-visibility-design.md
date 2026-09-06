# 普通排队消息自动接力可见性设计

## 目标

原生会话中的普通排队消息必须严格串行：上一条运行产生终态并完成 adapter 清理后，Broker 才能按 FIFO 提升下一条。消息一旦被提升并成功准入，应立即离开排队列表、进入消息区并显示当前运行反馈，不能出现已经执行但仍停在排队列表，或排队项消失后消息区暂时空白的状态。

## 调度边界

Broker 继续作为唯一调度者。renderer 不主动启动持久排队项，也不根据界面状态自行出队，避免与 `NativeRuntimeBrokerHost.executeRun()` 的终态清理和下一项 admission 竞争。

现有服务端顺序保持不变：当前 run 写入终态，adapter generator 的清理结束，Broker 完成 active 项，随后提升并启动下一条。若上一条仍 active 或仍在清理，下一条必须保持 queued。

## 消息投影

renderer 的队列对账同时处理 `state.active` 和 `state.queued`：

- `kind=message` 且仍在 `queued` 的项目继续显示在排队列表。
- `kind=message` 且已成为 `active` 的项目立即复用其 `sourceMessageId`、正文、附件和 Agent 信息，转换为非排队用户消息并显示在消息区。
- active 普通消息不进入目标队列；消息区的运行状态继续使用现有“思考中”反馈。
- transcript 到达后，优先按稳定来源 ID 对齐；Codex 已持久化输入而没有内部 run 标记时，只匹配最新且正文相同的用户边界，不生成第二条相同用户消息，也不误合并更早的同文轮次。
- active 项结束后，以 transcript 历史为准；队列投影不保留已经结束的临时 active 项。

## 错误处理

排队项只有在 Broker 返回 active 后才从排队样式转换为运行消息。启动失败时，Broker 将该 active 项记为 failed 并继续处理下一项；renderer 通过终态事件和历史对账显示现有错误，不把失败项悄悄恢复成 queued，也不重复执行。

会话刷新、后台会话更新和会话切换继续使用显式 session ID，不能让一个会话的提升状态覆盖另一个会话的消息区。

## 实现范围

- `packages/desktop/renderer/lib/queued-message-order.ts`：扩展持久队列消息投影，使 active 普通消息成为非排队用户消息。
- `packages/desktop/renderer/components/ChatView.tsx`：所有队列状态对账入口传入完整状态，不改变 Broker 调度调用。
- `packages/desktop/renderer/lib/queued-message-order.test.ts`：覆盖 queued 保留、active 立即出队、附件保留、transcript 对账去重和跨会话隔离所需的纯函数契约。
- 相关 ChatView 静态契约测试：确认 renderer 不自行启动持久 active 项。

不修改 Broker FIFO、目标优先级、原生运行时协议、停止语义或目标模式展示。

## 验证

- 运行排队投影、会话历史合并和 ChatView 相关聚焦测试。
- 运行 Desktop 与 WebApp TypeScript 检查及 `git diff --check`。
- 回归场景：第一条仍运行时第二条保持在排队列表；第一条终态且清理完成后，第二条只出现于消息区并开始运行；transcript 刷新后用户消息仍只有一条。

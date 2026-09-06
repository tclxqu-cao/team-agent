# Codex 会话兼容性自动验证设计

## 目标

侧栏标题右侧的兼容性转圈只表示 `compatibility.status=checking`，会话状态继续由标题左侧的小圆点表示。新发现的可探测 Codex 会话进入 `checking` 后，应在后台自动完成一次兼容性验证，不要求用户先发送消息或打开会话。

验证成功后状态更新为 `direct`，转圈自动消失；验证失败后状态更新为 `incompatible`，沿用现有警告图标和错误原因。

## 触发边界

自动验证由 `CodexSessionCompatibilityService` 负责。磁盘目录完成增量扫描后，只把本次新出现或文件身份发生变化、且状态为 `checking` 的可探测条目加入验证队列。

启动时从持久缓存恢复的大批历史 `checking` 条目不自动全量验证。它们继续使用现有按需读取验证路径，避免应用启动时对当前约 227 条历史记录逐一调用 Codex runtime。后续文件监听发现的新条目可以自动验证。

同一 `nativeSessionId` 同时最多存在一个验证任务。文件再次变化时，旧任务的结果只有在条目的 `size`、`mtimeNs` 等身份仍一致时才能落盘，防止迟到结果覆盖新版文件状态。

## 验证流程

目录层向兼容性服务报告新增的 `checking` 条目，兼容性服务通过现有 adapter 读取对应会话：

- 读取成功：复用当前 `direct` 状态写入逻辑，保留 reader、producer 和 formatKey 信息。
- runtime 暂时不可用：本次不把会话永久判为格式不兼容，保留 `checking` 并允许后续目录变化或显式读取重试。
- runtime 明确无法读取该会话：复用当前 `CODEX_SESSION_DIRECT_READ_FAILED` 结果，写入 `incompatible` 及原因。
- 条目不可探测：不进入自动队列，保持现有 schema unknown 处理。

后台任务不阻塞会话列表、工作区列表或应用首屏。并发数保持较小且固定，避免同时读取多个 rollout 对 app-server 造成突发压力。

## 状态传播

兼容性结果继续写入 `CodexSessionDiskCatalog` 及其 repository。更新完成后使统一会话发现缓存和对应工作区页缓存失效，让下一次现有列表刷新拿到权威状态。

若当前 UI 已展示该条目，renderer 通过选中原生会话已有的 10 秒目录刷新接收新摘要；后台验证完成后，转圈最迟在下一次刷新时消失。不新增事件通道或每行轮询。侧栏组件本身无需改变：`checking` 显示转圈、`direct` 不显示兼容性图标、`incompatible` 显示警告。

## 实现范围

- `codex-session-disk-catalog.ts`：暴露本轮增量扫描产生的待验证条目或通知，不负责调用 runtime。
- `codex-session-compatibility.ts`：实现有界并发、同会话去重、条目身份校验和验证结果分类。
- `unified-session-service.ts` / 工作区索引：在兼容性结果变化后失效相关发现缓存，使结果可被列表读取。
- 聚焦测试：覆盖新条目自动转为 direct、明确失败转为 incompatible、runtime 暂时不可用保持 checking、历史缓存不全量验证、重复通知去重、文件变化后的迟到结果不覆盖新状态。

不修改侧栏会话状态小圆点、会话创建和发送流程、原生运行准入、历史会话按需验证语义，也不在 renderer 增加兼容性探测请求。

## 验证

- 运行 Codex disk catalog、compatibility service、unified session service 和 workspace index 聚焦测试。
- 运行 Desktop 与 Server TypeScript 检查及 `git diff --check`。
- 实页回归：创建 Codex 空会话且不发送消息，标题右侧短暂显示转圈后自动消失；运行状态小圆点保持 idle。再用不可读取 fixture 验证转圈最终切换为警告图标。

# Codex Visualize 交付物与会话主动对账设计

## 目标

修复 WebApp 中两类原生 Codex 会话展示问题：

1. Codex 助手消息中的 `visualize` 结构化标记不再显示为原始乱码文本，而是渲染为可点击的本地交付物入口。
2. WebApp 自己启动的原生会话在消息已经写入 transcript 后主动更新，不再依赖用户刷新页面恢复漏掉的消息。

桌面端没有 Web 文件树桥，继续保留原始文本，不新增无效入口。

## Visualize 标记契约

Codex 可能在助手正文中输出如下私有标记，其中分隔符分别是 Unicode `U+E200`、`U+E202` 和 `U+E201`：

```text
\uE200visualize\uE202{"path":"/absolute/demo.html","mode":"wide","title":"原型图"}\uE201
```

共享 `markdown-links` tokenizer 将该标记与 Markdown 链接、Codex file citation、inline code 一起按起始位置排序。先出现的外层 token 消费重叠区间，避免一个标记被重复或局部识别。

解析规则：

- JSON 必须是对象，`path` 必须是绝对 POSIX 路径，并继续复用现有本地交付物路径校验。
- `title` 为非空字符串时作为链接标签；否则使用路径 basename。
- `mode` 只属于 Codex 展示元数据，本次不参与文件预览行为。
- JSON 非法、路径相对、包含查询参数或片段、字段类型错误时保留完整原文，不创建按钮。
- 解析只决定展示 token；实际文件读取仍经过现有 Web 文件树桥和服务端路径权限检查。

`ChatView` 复用现有 `artifact` token 渲染和 `postWebArtifactOpen(path)`，不新增第二套交付物组件。这样实时消息和刷新恢复的历史消息使用同一展示规则。

## 原生会话主动对账

现有 WebApp 有两条更新链路：

- `/api/agent/stream` 传输当前运行事件，负责低延迟显示文字、思考和工具调用。
- `/api/sessions/:id/changes` 监听 transcript 文件变化，只发送 revision 信号；`ChatView` 收到信号后重新读取最新一页并合并尾部。

当前 `shouldFollowNativeHistory` 只允许外部占用或没有本地运行标记的原生会话订阅 transcript。本 WebApp 启动的运行因此完全依赖主事件流；若某条已落盘消息未进入主流，页面不会再对账。

调整后，只要当前选择的是 Codex、Claude Code 或 OpenCode 原生会话，就允许建立 transcript 变化订阅，不再因为 `runningSessionId` 指向当前会话而排除。主事件流继续作为实时通道，transcript 变化只触发现有的有界历史刷新和尾部合并。

对账继续遵守以下约束：

- 页面隐藏时停止观察，重新可见时立即刷新并恢复观察。
- 同一时刻最多执行一次历史刷新；刷新期间的新 revision 合并为下一轮刷新。
- 保留已加载的旧分页、乐观附件和排队消息，不用不完整 transcript 清空当前界面。
- 用户不在消息底部时不强制滚动；在底部附近时随新消息自然跟随。
- EventSource 不可用或失败时，仅对运行中或外部占用会话启用现有 2 秒轮询兜底；空闲会话不持续轮询。
- transcript 路径仍由 runtime adapter 验证，浏览器和公共 API 不接触文件系统路径。

## 组件边界

- `packages/desktop/renderer/lib/markdown-links.ts`：识别并验证 `visualize` 标记，输出既有 `artifact` token。
- `packages/desktop/renderer/components/ChatView.tsx`：继续负责交付物渲染，并使用已有历史观察与尾部合并流程。
- `packages/desktop/renderer/lib/native-session-view-state.ts`：放宽当前原生会话的 transcript 跟随判定。
- 既有 Server changes route、文件 watcher、Web gateway 和历史合并器保持接口不变。

## 错误处理

- 单个非法 `visualize` 标记只降级为文本，不影响同一消息中的其他 Markdown 内容。
- transcript 观察失败不显示阻断错误；运行中会话自动转入轮询，主事件流保持工作。
- 历史刷新失败记录控制台诊断并等待下一次 revision 或轮询，不覆盖现有消息。

## 测试与验收

- tokenizer 单测覆盖合法标记、缺省标题、非法 JSON、相对路径、危险路径和与 inline code/Markdown 的重叠。
- `native-session-view-state` 单测覆盖本地运行、外部运行和空闲原生会话均可主动跟随，Customer Agent 会话不跟随。
- 历史合并现有回归必须继续通过，证明主动对账不会重复最终回复、丢旧分页、乐观附件或排队消息。
- 运行受影响的 renderer、Web gateway 和 Server watcher/changes route 测试，以及 Desktop/WebApp 类型检查。
- 按项目规则使用 ego-browser 在桌面与 390px 移动视口验证：历史 `visualize` 标记显示为交付物按钮；模拟 transcript 新消息后页面无需刷新即可出现，且无重复消息或滚动跳动。

## 非目标

- 在聊天消息内直接嵌入和运行完整 HTML 原型。
- 修改 Codex 协议或把私有标记改写回 transcript。
- 为 Customer Agent SQLite 会话增加文件监听。
- 改变现有文件预览权限、分享或下载能力。

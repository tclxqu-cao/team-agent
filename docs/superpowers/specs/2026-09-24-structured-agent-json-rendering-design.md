# Agent 结构化 JSON 消息渲染设计

## 背景

Customer Agent、Codex、Claude Code 等运行时的助手回复最终都进入共享的 `ChatView`。当回复是完整 JSON 时，当前实现仍把它交给 Markdown 文本渲染器，因此 `schemaVersion`、`blocks`、`suggestions` 等协议字段会与正文一起平铺出来，既难读，也暴露了本应由界面解释的展示协议。

当前个人主页 Agent 已使用 `schemaVersion: 1`、`title`、`blocks`、`suggestions`、`sources` 和 `generatedAt` 组成的消息信封。这个协议可能由 Customer Agent 或其他运行时返回，所以识别规则必须基于消息内容，而不能绑定某一种 Agent 类型。

## 目标

1. 完整的已知 Agent 消息信封显示为紧凑、可读的结构化内容，而不是裸 JSON。
2. 其他完整合法 JSON 显示为可折叠的键值树，避免所有未知结构继续平铺。
3. `/whoami` 等建议项显示为中文快捷操作，点击后直接发送对应命令。
4. Desktop 与 WebApp 复用同一实现和同一套主题变量，行为与视觉保持一致。
5. 普通文本、Markdown、代码围栏、混合正文和解析失败内容保持现有行为。
6. 不执行来自模型输出的 HTML、脚本或任意事件处理器，不因美化渲染扩大信任边界。

## 方案比较与决策

### 方案 A：已知信封 + 通用 JSON 两级渲染（采用）

先识别已知 Agent 消息信封并按业务语义展示；无法识别为已知信封、但整条消息是合法对象或数组时，显示通用 JSON 树。覆盖当前截图，也让其他 Agent 的结构化结果有稳定降级路径。

### 方案 B：只支持个人主页信封

实现最小，但其他 Agent 的合法 JSON 仍然难读，且会把共享消息渲染继续绑定到某个具体 Skill。

### 方案 C：所有 JSON 一律显示通用树

覆盖面广，但丢失 `title`、`blocks`、`suggestions` 和 `sources` 的业务语义，无法提供直观的中文快捷操作。

采用方案 A。它以一个内容识别边界覆盖多运行时，同时保留未知数据，不要求上游 Agent 同时改造。

## DDD 与组件边界

本功能属于“对话消息展示”上下文。外部 Agent 文本是不可信输入，结构化消息解析器作为防腐层，把传输文本翻译为受控的展示模型。

依赖方向为：

```text
React presentation -> message presentation model -> untrusted assistant text
                  -> chat submit use case
```

- `StructuredAgentMessage` 是纯 TypeScript 判别联合，表达已知信封、通用 JSON 和非结构化文本三种结果。
- `parseStructuredAgentMessage` 只负责识别、校验、限制大小和建立展示模型，不依赖 React、DOM、Electron、Web API 或消息发送状态。
- `StructuredAgentMessageView` 只把已校验的展示模型渲染为 React 节点，不读取会话 store，也不自行发送消息。
- `ChatView` 是组合根：只在顶层助手正文完成后调用结构化渲染，并把现有聊天提交用例作为 `onSuggestionSend` 回调注入。
- 现有 `renderAssistantText` 继续负责 Markdown、表格、代码围栏、Mermaid 和行内链接，不承担协议识别。文本 block 复用它，推理摘要和 Chrome Hub 不会被意外改成 JSON 卡片。

解析和展示组件放在 `packages/desktop/renderer` 的共享源码内。虽然目录名保留历史命名，Desktop 与 `@agent/webapp` 都消费这套 renderer，因此不复制 Web 专用实现。

## 识别规则

结构化渲染只在以下条件全部满足时启动：

1. 消息角色为 `assistant`，并且该条回复已经结束流式输出。
2. 去除首尾空白后，整条消息能被 `JSON.parse` 解析。
3. 根节点是对象或数组，且消息长度不超过结构化解析上限。

以下内容明确不识别：

- JSON 前后还带解释文字的混合正文。
- 带 `json` 语言标记的代码围栏及其他代码块。
- 尚未完成的流式 JSON。
- JSON 字符串、数字、布尔值或 `null` 根节点。
- 超过上限、解析失败或校验失败的内容。

这些情况全部回到现有 `renderAssistantText`，不显示错误，不改变原消息。

### 已知消息信封

满足以下最小结构时识别为已知信封：

- 根节点是对象。
- `schemaVersion` 是数字。
- `title` 是非空字符串。
- `blocks` 是数组。

`skill`、`summary`、`suggestions`、`sources` 和 `generatedAt` 是可选展示字段。字段缺失不会让整个消息失败；单个无效 block 进入“未识别内容”折叠区，不能导致其他有效 block 消失。

首期支持：

- `text` block：复用现有安全 Markdown 渲染。
- 其他 block：以类型名和安全的通用 JSON 子树展示，不执行 `html`，也不直接加载未知媒体 URL。

这种边界先解决当前文本信封问题，同时避免把模型返回的 HTML 当作受信页面执行。图片、视频和受限 HTML 的富媒体预览需要独立 URL 策略与沙箱设计，不混入本次改动。

### 通用 JSON

其他合法对象或数组显示为递归键值树：

- 对象显示字段名和值；数组显示序号和长度。
- 第一层默认展开，深层对象与数组可单独展开或折叠。
- 字符串保留换行并自动换行；数字、布尔值和 `null` 使用不同但克制的语义颜色。
- 空对象和空数组有明确占位。
- 单个容器项目过多时先显示前一批，再由“显示更多”逐步展开；数据不会静默丢弃。
- 最底部保留“查看原始 JSON”，使用格式化代码视图并支持复制。

## 已知信封的视觉与交互

结构化消息仍处于原助手消息区域内，不再嵌套一张装饰性大卡片：

- 标题使用消息内的小标题层级，不使用 Hero 尺寸。
- `summary` 有值时显示为标题下的低对比度摘要。
- text blocks 之间使用留白和细分隔线建立层级。
- `sources` 为空时不显示；有值时显示“参考来源 N”，默认折叠。
- `skill`、`schemaVersion` 和 `generatedAt` 收在“消息信息”折叠区，不占用主阅读路径。
- “原始 JSON”默认折叠，便于排查和复制完整数据。

所有颜色、边框、悬停态和焦点态只使用现有 `--bg-*`、`--text-*`、`--accent-*`、`--border-*` 与半径变量，保证每套皮肤自动一致。按钮最大圆角为 8px，并提供键盘焦点、tooltip 和可访问名称。

### 建议项

已知命令显示为中文操作：

| 命令 | 展示文字 |
| --- | --- |
| `/help` | 使用帮助 |
| `/whoami` | 关于我 |
| `/works` | 项目与作品 |
| `/jobs` | 求职信息 |
| `/timeline` | 经历时间线 |
| `/contact` | 联系方式 |
| `/project <id>` | 查看项目：`<id>` |

未知建议保留原文字，避免隐藏实际会发送的内容。每个按钮的 tooltip 和 `aria-label` 都包含原始命令。

点击后直接发送，不先填入输入框。发送必须复用现有聊天提交用例：

- 空白会话按当前 Agent 和项目创建会话。
- Agent 正在运行时沿用现有排队规则。
- 不携带输入框里尚未发送的附件、`@Agent` 选择或目标模式。
- 不覆盖或清空用户正在编辑的草稿。
- 当前不可发送时按钮禁用，并沿用现有可发送状态。

因此需要从现有 `handleSend` 中抽出“提交给定文本”的应用操作；输入框发送与建议按钮发送共用它，不能通过临时 `setInput` 再触发发送来制造 React 状态竞态。

## 安全与错误降级

- 所有字符串都作为 React 文本节点输出；禁止用 `dangerouslySetInnerHTML` 渲染模型字段。
- `html` block 首期只显示为未执行的结构化数据。
- 链接仍经过现有 Markdown 链接策略，未知 JSON 字符串不会自动成为可点击链接。
- 建议按钮只在用户主动点击后发送，且界面明确暴露将发送的原始命令。
- 解析器设置消息长度、嵌套深度和单次展开数量上限，避免超大 JSON 阻塞界面。
- 任意解析、校验或渲染异常都局部降级到原始文本，不影响会话其他消息。

## 测试与验收

### 纯逻辑测试

- 识别标准 `schemaVersion/title/blocks` 信封及可选字段。
- 合法未知对象和数组进入通用 JSON 模式。
- 普通文本、混合正文、代码围栏、标量 JSON、超限 JSON 和非法 JSON 全部降级。
- 无效 block 不影响有效 text block，未知字段仍能从折叠内容或原始 JSON 查看。
- 嵌套深度、批量展开和长度限制生效。

### 组件测试

- 标题、摘要、text block、来源数量、消息信息和原始 JSON 正确呈现。
- `/whoami` 显示“关于我”，点击回调仍收到精确的 `/whoami`。
- 未知建议显示原文字；键盘激活、禁用态、tooltip 和 `aria-label` 正确。
- `<script>`、事件属性和 HTML block 不会进入可执行 DOM。
- 通用树能展开对象和数组、显示空值并复制原始 JSON。

### 聊天集成测试

- 建议按钮直接走当前运行时的发送链路；新会话、现有会话和运行中排队三种路径与输入框发送一致。
- 点击建议不会清空已有草稿，不会附带待发送图片或 `@Agent`。
- 流式期间保持文本输出，完成后稳定切换成结构化渲染。
- 推理摘要、工具结果、用户消息、Markdown 表格、代码块和 Mermaid 行为不变。

### 运行验收

- 使用 Node 22 运行相关 Vitest、TypeScript 检查和 Desktop/WebApp 构建。
- 在 WebApp 桌面与窄视口验证已知信封、通用树、主题切换、键盘操作和直接发送。
- 启动 Electron，用同一条示例回复验证布局、皮肤、展开折叠、复制和快捷发送。
- 对比改动前后普通 Markdown、JSON 代码围栏和包含花括号的普通文本，确认无误判。

## 非目标

- 修改 Agent 的输出协议或提示词。
- 自动执行 JSON 中的工具调用、URL、HTML 按钮或任意动作字段。
- 在本次改动中实现 HTML block、远程图片或视频的富媒体运行时。
- 把通用 JSON 查看器扩展成 JSON 编辑器、Schema 设计器或下载工具。
- 修改 WebApp 与 Desktop 之外的公开个人主页渲染器。

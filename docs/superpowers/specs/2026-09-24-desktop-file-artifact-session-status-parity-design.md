# AgentRoam Desktop 文件、交互物与会话状态一致性设计

## 背景

当前 Web 控制台已经具备“我的文件”入口、右侧文件/历史抽屉、文件树、文件预览、文本编辑、Git 变更查看、下载/分享，以及从助手消息中的本地文件链接自动定位并打开预览的完整链路。Electron 桌面端虽然复用了聊天界面，但显式关闭了交互物文件预览，也没有文件管理入口。

侧边栏的 Codex 会话状态还存在另一类一致性问题：工作区每 15 秒刷新一次时使用 `refreshLoadedSessions: false`，只有当前选中项目每 10 秒刷新会话。已展开但未选中的项目会长期保留旧的 `running` 摘要，因此任务实际完成后仍显示转圈。

WebApp 新建的原生 Codex 会话最终会出现在官方 Codex Desktop，说明持久化链路是通的；等待时间来自官方客户端自己的索引和刷新节奏。AgentRoam 不能调用官方 Codex Desktop 的内部刷新能力，因此本设计不承诺让官方客户端即时出现新会话。

## 目标

1. Electron 聊天标题栏增加与 Web 控制台语义一致的“我的文件”图标，并提供右侧文件/历史抽屉。
2. Web 与 Electron 共享同一套文件工作区展示和应用行为，而不是复制两份逐渐分叉的组件。
3. Electron 中的助手文件链接、工具结果、文件变更摘要和 Codex 执行轨迹，都能像 WebApp 一样打开并定位真实文件预览。
4. 文件浏览、预览、编辑、变更、下载/分享、监听刷新和错误反馈在两个环境保持能力一致。
5. 已完成的 Codex 会话及时停止转圈；选中项目和已展开项目都能从权威数据恢复正确状态。
6. 方案符合 DDD：领域语义、应用编排、端口、基础设施适配器和 React 展示层有明确依赖方向。

## 设计决策

采用“共享领域与应用契约 + 共享无环境 UI + Web/Electron 基础设施适配器”的方案。

不让 React 组件直接判断 `isWebShell()` 后决定能力，也不让共享组件调用 WebSocket、HTTP、Electron IPC 或 Node 文件系统。界面只调用应用端口；运行环境在组合根注入实现。

依赖方向固定为：

```text
Presentation -> Application -> Domain
                         ^
                         |
                Infrastructure adapters
```

基础设施可以依赖应用端口和领域类型，领域层不反向依赖 Electron、Next.js、WebSocket、React 或具体数据库。

## DDD 边界

### 文件工作区上下文

负责“用户在一个允许的宿主机范围内浏览和操作文件”的业务语义。

领域对象包括：

- `WorkspaceRoot`：被授权的规范化根目录标识，不直接等同于渲染进程传入的字符串。
- `WorkspacePath`：根目录内的规范化文件路径；可携带展示路径，但不能越过所属根目录。
- `FileNode`：目录项、类型、大小、修改时间和是否存在子项。
- `PreviewDescriptor`：文本、图片、视频、音频、PDF、浏览器预览或十六进制预览等类型。
- `TextChangeState`：`changed`、`unchanged`、`untracked`、`unavailable`。

应用端口按读写职责拆分：

- `FileWorkspaceQueryPort`：列目录、stat、分块读取、文本检查、预览票据和订阅变更。
- `FileWorkspaceCommandPort`：保存文本、关闭预览票据和停止监听。
- `FileWorkspaceFacade`：向展示层提供 `revealFile`、`openPreview`、`saveText`、`download`、`share` 等用例，不暴露传输协议名称。

现有 `FileTree`、`FilePreview` 和抽屉壳迁到共享展示模块，依赖 `FileWorkspaceFacade`。文件类型识别继续使用 Core 中已有的 `domain/file` 规则。

### 会话目录上下文

负责工作区下会话摘要及其活动状态，不与文件工作区混合。

- `SessionActivity` 统一表达 `running`、`needs-input`、`idle`、`stale`。
- `SessionActivityProjection` 是纯领域规则：权威会话摘要与本地正在执行的 run 可以把状态提升为 `running`；终止事件会立即撤销本地运行态；数据超过新鲜度窗口且刷新失败时进入 `stale`，不继续显示“正在运行”动画。
- `ReconcileVisibleSessions` 应用用例负责刷新“当前选中项目 ∪ 已展开项目”，并对同一项目的并发刷新做合并。

### 交互物上下文

助手消息只识别交互物引用，不读取文件系统。

- `ArtifactReference` 保存绝对路径、可选行号和展示标签。
- `OpenArtifact` 用例把合法引用转换为文件工作区的 `revealFile` 请求。
- Conversation/Chat 通过该用例与文件工作区协作，不依赖 Web `postMessage` 或 Electron IPC。

Web 环境继续通过已有同源 `postMessage` 桥把交互物请求交给外层控制台；Electron 环境直接调用当前窗口注入的 `FileWorkspaceFacade`。两者最终产生同一行为：打开文件页签、展开父目录、选中并滚动到目标、打开预览。带行号的路径继续去掉行号后定位，本次不新增预览内行号滚动。

### 终端历史上下文

“历史”页签属于终端上下文，不并入文件领域。共享抽屉只组合 `CommandHistoryPort`：查询、搜索、复制、删除和置顶行为保持一致。Electron 没有活动终端时，沿用 Web 现有规则禁用“填入/执行”，并显示“请先打开一个终端页签”；不会错误地把终端命令填入聊天输入框。

## 组件与代码归属

### Core

在 `packages/core/src/domain` 中放置文件工作区值对象、预览类型、交互物引用和会话活动投影规则；在 `packages/core/src/application` 中放置文件工作区 facade、打开交互物用例和可见会话协调用例。Core 只导出 TypeScript 契约与纯逻辑。

### 共享展示层

以 `packages/desktop/renderer` 作为当前桌面和 `@agent/webapp` 已共同使用的展示源，建立聚合后的文件工作区模块，承载：

- `FileWorkspaceDrawer`
- `FileTree`
- `FilePreview`
- `CommandHistoryPanel`
- `useFileWorkspaceController`

`packages/server/app/web/page.tsx` 和 Electron `App.tsx` 都组合这一模块。服务器页面不再拥有一套独立的文件树与预览业务实现。

### Web 适配器

Web 适配器把应用端口映射到现有 `fs:list`、`fs:stat`、`fs:read`、`fs:inspect-text`、`fs:write-text`、`fs:preview-open`、`fs:preview-close`、`fs:watch` RPC，以及现有命令历史 HTTP API。现有 CSRF、同源、预览票据和网关路径策略保持不变。

### Electron 适配器

Electron preload 暴露类型化的最小文件工作区 API。主进程处理器负责：

- 从主进程维护的工作区索引解析授权根目录，不信任渲染进程自报的根目录。
- 使用 `HostPathPolicy` 规范化路径并拒绝 `..`、符号链接逃逸和根目录外访问。
- 提供目录、stat、分块读取、文本检查、受限写入和文件监听能力。
- 为图片、音视频、PDF、HTML/Markdown 预览生成短生命周期票据；Electron 自定义协议只接受有效票据并支持流式读取，关闭预览时立即撤销。
- 校验 IPC sender，仅允许当前受信窗口调用。

新文件工作区功能不得调用现有不受根目录约束的 `file:read` / `file:write`。是否统一收紧旧调用属于后续安全治理，不扩大本次改动范围。

## 用户交互

- 聊天标题栏使用 Lucide `PanelRight` 图标，名称为“我的文件”，提供 tooltip、`aria-label`、`aria-expanded` 和激活态。
- 点击后在 Electron 主布局右侧打开“文件 / 历史”工作区；再次点击标题栏文件按钮或点击文件区头部的关闭按钮收起。
- 文件区头部只展示“文件 / 历史”标签和关闭按钮，不重复展示当前工作目录；目录路径仅保留在下方可操作的定位输入框与文件树根节点中。
- Electron 使用真实 Dock Grid：消息区和文件工作区是相邻网格列，文件区不得使用绝对定位、阴影覆盖或 `margin-right` 占位补偿。折叠文件区时直接移除右侧网格列，消息内容和消息区顶部操作栏同步扩展到主布局右边界，不保留空白占位。
- 文件预览始终留在 Electron 右侧工作区内，不覆盖消息区。宽屏时文件树和预览并列；较窄的受支持桌面宽度下，预览在同一右侧列中替换文件树，关闭预览后返回文件树。
- 以上 Dock 规则仅属于 Electron 组合根。WebApp 的 `/web` 文件抽屉、移动端覆盖层、断点、开关和共享 `FileTree` / `FilePreview` 行为保持不变。
- 文件树跟随当前项目工作目录；用户手动切换根目录后停止跟随，重新选择“定位当前目录”才恢复。
- 点击助手正文文件链接、工具卡文件、文件变更摘要或执行轨迹中的文件目标时，自动打开抽屉并定位预览。重复点击同一路径仍重新滚动定位。
- HTML/Markdown 使用现有受限浏览器预览；文本支持原文/变更切换和安全编辑；媒体、PDF、未知二进制、下载与系统分享沿用 Web 当前能力和上限。
- 抽屉的根目录、跟随模式、页签和最后选中文件按运行环境现有偏好存储恢复，不跨项目错误复用选中路径。

## 会话状态同步

1. 工作区增量轮询继续只更新工作区目录，不顺带刷新所有缓存会话。
2. 新增可见会话协调器，每 10 秒刷新当前选中项目与全部已展开项目；项目 ID 去重，同一项目同一时刻最多一个请求，刷新并发有上限。
3. 窗口从后台恢复焦点时立即执行一次可见项目刷新，不等待下一个定时器。
4. 收到 `task_complete`、run complete、abort 或 terminal error 等终止事件时，先清除对应会话的本地运行态，再立即刷新其所属项目。即使该项目已不再选中，也按事件携带的 owner project 刷新。
5. 刷新返回的权威 `idle` 状态覆盖旧缓存中的 `running`；失败时保留摘要内容但把过期活动状态标为 `stale`，不继续显示旋转图标。
6. 会话行的转圈只由 `SessionActivity === running` 决定，不能再直接散落判断 `session.status === "running" || runningSessionId === session.id`。

该策略修复 AgentRoam 自己的状态陈旧，不尝试控制官方 Codex Desktop 的刷新周期。

## 错误与安全

- 路径无效、越界、已删除或无权限时，在抽屉内显示明确错误并保留聊天内容，不发起系统导航。
- 保存文本时保留现有大小、UTF-8 和外部修改检查；发生并发修改时要求用户重新加载或明确覆盖。
- 文件监听断开只影响自动刷新，树和当前预览仍可手动重试。
- 预览票据与工作区根、文件路径和创建窗口绑定，过期、跨窗口或关闭后的票据不可复用。
- HTML/Markdown 预览保持 sandbox 和内容安全策略，不获得 Node、preload 或父窗口权限。
- 会话刷新失败不能把未知状态宣称为已完成；使用静态 `stale` 状态区分“无法确认”和“正在执行”。

## 测试与验收

### 领域与应用测试

- `WorkspacePath` 覆盖正常路径、根目录本身、`..`、不同根、符号链接逃逸和不存在路径。
- `OpenArtifact` 覆盖绝对路径、带行号路径、重复打开、越界目标和适配器失败。
- `SessionActivityProjection` 覆盖权威 idle、本地运行、终止事件、刷新失败过期和恢复刷新。
- `ReconcileVisibleSessions` 覆盖 selected/expanded 并集、去重、并发合并、项目切换和窗口聚焦。

### 适配器契约测试

- Web 与 Electron 适配器通过同一套文件工作区端口契约测试。
- Electron IPC 覆盖非法 sender、伪造根目录、目录穿越、符号链接逃逸、超限读取/写入、票据过期和 Range 读取。
- Web 现有 RPC、CSRF、命令历史和预览票据测试保持通过。

### 展示测试

- 标题栏图标、文件区关闭按钮、打开/关闭、焦点顺序、可访问名称和窄宽度布局。
- Electron 展开时文件区左边界与消息区右边界相接且不重叠；折叠后消息区与顶部操作栏的右边界等于主布局右边界。样式契约不得包含文件区绝对定位、覆盖阴影或消息区 `margin-right` 补偿。
- WebApp 继续通过原有 `.workspace.show-tree` / `.tree-col` 规则控制抽屉；Electron Dock 样式不得修改这些选择器或 Server 页面组合逻辑。
- 四类交互物入口都触发同一个 `OpenArtifact` 用例，不再受 `isWebShell()` 限制。
- 文件树定位、选择、滚动、预览、编辑、变更、下载/分享和错误状态。
- 已展开但未选中项目完成任务后停止转圈；选中项目、后台恢复和终止事件也能立即收敛。

### 运行验收

- 使用 Node 22 运行 Core、Desktop、WebApp、Server 的相关测试、类型检查和构建。
- 按项目规则用 ego-browser 验证 Web 桌面视口与窄视口：文件/历史抽屉、预览和交互物链接无回归，开关前后的原有布局尺寸保持不变。
- 启动真实 Electron，验证文件图标、文件区头部关闭按钮、Dock 分栏、折叠后消息区全宽、HTML/Markdown/图片/PDF 预览、文本编辑与一次越界拒绝。
- 选取一个已完成但曾缓存为 running 的 Codex 会话，验证在终止事件或不超过 10 秒的可见项目刷新后停止转圈。
- 官方 Codex Desktop 仅记录“最终可见”的观察结果，不把出现时间作为 AgentRoam 的可控验收项。

## 迁移顺序

1. 先建立领域类型、应用端口和适配器共用契约测试。
2. 把现有 Web 文件树、预览和历史面板迁到共享展示模块，确保 Web 行为不变。
3. 接入 Electron 受限 IPC、预览协议与标题栏抽屉。
4. 把聊天中的所有文件入口统一接入 `OpenArtifact`。
5. 引入会话活动投影和可见项目协调器，替换散落的 running 判断与轮询。
6. 完成 Web 和 Electron 的构建及真实交互验收。

## 非目标

- 修改或逆向调用官方 Codex Desktop 的刷新机制。
- 把任意本地绝对路径开放给渲染进程。
- 新建独立文件管理产品、批量文件操作、拖拽上传或完整代码编辑器。
- 在 Electron 中虚构终端上下文，或把终端命令历史改造成聊天历史。
- 顺手重构与本功能无关的桌面设置、AI Hub、远程桌面或会话编辑功能。

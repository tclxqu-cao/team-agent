# AgentRoam 按 Agent 独立工作区索引设计

## 目标

在侧栏顶部增加 Agent 切换器。用户切换到 Customer Agent、Codex、Claude Code 或 OpenCode 后，只加载该 Agent 的工作区目录；展开目录后再分页加载会话。每个 Agent 独立缓存、独立增量刷新并恢复自己的选择与滚动位置。

Codex 的项目名称和项目排序以 Codex 为真相源：Codex 改名后 AgentRoam 无感更新，Codex 调整顺序后 AgentRoam 保持完全相同的顺序。

新切换器成为唯一的 Agent 维度，因此删除现有“会话按 Agent 分组”按钮及其全部状态、渲染分支和样式。

## 方案选择

评估过三种实现方式：

1. 仅在现有全量会话结果上增加前端 Agent 过滤。改动最少，但应用启动仍会发现所有运行时和所有会话，不能解决第一次加载卡顿，也无法可靠读取 Codex 原生名称与排序。
2. 建立按 Agent 分区的工作区索引领域服务。各适配器提供原生工作区与分页会话，应用层统一缓存、增量和竞态处理，展示层只消费统一模型。该方案边界清楚，能同时满足性能、重命名和排序要求，选为实施方案。
3. 直接读取各 Agent 的私有数据库或目录并在前端构建索引。冷启动可能更快，但会绕过公开协议、放大版本兼容风险，也会把基础设施细节泄漏到界面层，因此不采用。

## 非目标

- 不扫描整块磁盘寻找代码目录，只展示各 Agent 原生历史或项目目录中已知的工作区。
- 不修改、重命名或重排任何 Agent 原生项目。
- 不把外部 Agent 的会话复制到 Customer Agent 数据库。
- 不猜测合并两个无法证明为同一工作区的路径。
- 不在应用启动时预加载四个 Agent 的所有工作区和会话。

## 用户体验

### Agent 切换

在 AgentRoam 品牌区下方、目录工具栏上方放置四项分段切换器。每项显示 Agent 的短名称和可用状态，使用以下稳定顺序：

1. Customer Agent
2. Codex
3. Claude Code
4. OpenCode

首次进入恢复上次使用的 Agent；没有缓存时默认 Customer Agent。切换只改变侧栏索引，不中断正在运行的会话。若当前聊天属于另一个 Agent，聊天仍保持可见，直到用户选择新 Agent 下的目录或会话。

### 工作区目录

切换 Agent 后立即显示该 Agent 的持久缓存，同时后台刷新工作区索引。没有缓存时只在目录区域显示加载状态，不阻塞品牌区、切换器和聊天区。

工作区行展示原生名称；悬停提示当前根目录。Codex 使用 `project.name`，不能用路径 basename 覆盖。工作区可折叠，点击展开时才加载第一页会话。

各 Agent 的工作区顺序互相独立：

- Codex 严格使用 `project/list` 的 `position` 顺序，不按会话时间或名称二次排序。
- OpenCode 保留 `project.list` 返回顺序。
- Claude Code 保留官方 `listSessions` 返回的最近活动顺序，目录第一次出现的位置即其位置。
- Customer Agent 保留 `SQLiteProjectStore.list()` 的现有顺序。

后台增量刷新只替换发生变化的行，不能在刷新期间清空旧列表或跳回顶部。

现有会话排序按钮保持不变：未开启时沿用当前按会话新建时间倒序；开启后仅把进行中的会话稳定置顶，同一运行状态内仍按新建时间倒序。该按钮只调整目录内会话，不影响工作区目录的原生顺序。

### 会话分页

展开工作区时加载最近一页会话，默认每页 50 条。滚动到该工作区会话列表底部时加载下一页；同一页请求只允许一个在途实例。新页追加并按原生顺序去重，不重新创建已有行。

再次切换回 Agent 时恢复：

- 上次展开的工作区；
- 上次选中的工作区和会话；
- 每个工作区的分页游标；
- 侧栏滚动位置；
- 已加载的会话摘要。

缓存恢复后在后台获取第一页进行对账；后续页保持不动，除非其工作区身份失效或用户继续滚动。

## DDD 边界

### 领域层

新增独立的工作区索引领域模型，不复用 Customer Agent 的 `Project` 实体，因为外部 Agent 工作区没有相同的生命周期和写入权限。

```ts
type AgentType = "customer-agent" | "codex" | "claude-code" | "opencode";

interface AgentWorkspace {
  agentType: AgentType;
  workspaceId: string;
  name: string;
  roots: string[];
  order: number;
  updatedAt?: string;
  source: "native" | "derived";
}

interface WorkspacePage<T> {
  data: T[];
  nextCursor: string | null;
  watermark: string | null;
}
```

领域规则：

- 工作区身份是 `agentType + workspaceId`，名称、根目录和排序都是可变属性。
- 会话归属优先使用原生工作区 ID；没有原生归属时按规范化路径做最长根目录匹配。
- 同一刷新中的重复工作区按稳定 ID 去重。
- 同一工作区的会话按统一 session ID 去重。
- Codex 的 `order` 直接来自 `position`，不能在领域服务中重排。
- 路径别名只用于继续关联历史会话，不能作为展示名或新的主键。

### 运行时端口与适配器

`AgentRuntimeAdapter` 增加只读工作区能力，运行时差异留在基础设施适配器内：

```ts
interface AgentWorkspacePort {
  listWorkspaces(query?: {
    cursor?: string;
    limit?: number;
    since?: string;
  }): Promise<WorkspacePage<AgentWorkspace>>;

  listWorkspaceSessions(
    workspaceId: string,
    query?: { cursor?: string; limit?: number; refresh?: boolean },
  ): Promise<WorkspacePage<UnifiedSessionSummary>>;
}
```

适配规则：

- Codex：`project/list` 读取 `id/name/roots/position/updatedAt`；`project/changed` 使对应缓存失效。会话优先按 `projectId` 查询；旧线程没有 `projectId` 时按工作区 roots 与 thread `cwd` 关联。API 不可用时回退到已缓存项目，最后才使用会话 `cwd` basename 派生目录。
- OpenCode：`project.list` 提供项目身份和 worktree；`session.list({ directory })` 分页会话。保持原生项目顺序。
- Claude Code：官方 SDK 无项目列表，按 `listSessions({ limit, offset })` 分页读取摘要并按 `cwd` 归并工作区；`workspaceId` 使用规范化 cwd 的稳定摘要。已缓存别名用于显示名变化后的兼容，不自动合并两个不同路径。
- Customer Agent：项目来自 `IProjectStore.list()`，稳定 ID 使用 `Project.id`；会话来自 session store 的摘要查询，并按当前项目顺序展示。

### 应用层

新增 `AgentWorkspaceIndexService`，只负责编排，不解析任何厂商协议。职责包括：

- 按 Agent 独立 single-flight 加载工作区；
- 管理每个 Agent 的快照、水位和错误；
- 按工作区分页加载会话；
- 将改名、排序和新增/删除工作区合并为新快照；
- 旧请求晚返回时基于请求代次丢弃；
- 运行时失败时返回旧缓存并标记 stale，而不是返回空列表。

原有 `UnifiedSessionService` 继续负责会话详情、执行、占用和删除，不承担 UI 缓存。工作区查询经 native runtime broker 暴露给 Web 服务和 Electron，避免两端各自重写厂商协议。

### 接口层

Web 与 Electron 暴露相同语义：

```text
listAgentWorkspaces(agentType, cursor?, limit?, since?)
listAgentWorkspaceSessions(agentType, workspaceId, cursor?, limit?, refresh?)
```

Web 对应只读 HTTP 接口：

```text
GET /api/agent-workspaces?agentType=codex&limit=50&cursor=...
GET /api/agent-workspaces/:workspaceId/sessions?agentType=codex&limit=50&cursor=...
```

响应包含 `data`、`nextCursor`、`watermark` 和 `stale`。非法 Agent、工作区不存在和坏游标返回明确的 4xx；运行时不可用但有缓存时返回缓存和 `stale: true`。

### 展示层

把工作区缓存、选择和滚动恢复封装进 renderer 纯函数与 hook，`App.tsx` 只组合视图和命令。缓存键升级为按 Agent 分区的 v2 结构，v1 项目会话缓存不自动混入新结构。

旧的 `groupByBot` 从 `uiStore`、迁移逻辑、`App.tsx`、测试和 CSS 中完整删除；旧 localStorage 字段由 Zustand 下一版迁移时丢弃。

## 缓存与增量更新

浏览器缓存采用 stale-while-revalidate：

```ts
interface AgentWorkspaceCache {
  version: 2;
  activeAgent: AgentType;
  agents: Partial<Record<AgentType, {
    workspaces: AgentWorkspace[];
    watermark: string | null;
    selectedWorkspaceId: string | null;
    selectedSessionId: string | null;
    sidebarScrollTop: number;
    sessions: Record<string, {
      data: UnifiedSessionSummary[];
      nextCursor: string | null;
    }>;
  }>>;
}
```

服务端应用服务同时维护进程内 per-Agent 缓存，防止 Web 页面刷新重复触发四个运行时的全量发现。缓存失效粒度为 Agent 或工作区，不再清空全局 `discoveryPromise`。

增量策略：

1. 切换 Agent：同步恢复本地快照。
2. 请求 `since=watermark`：适配器支持增量时返回变化；不支持时返回新快照，应用层按稳定 ID 对账。
3. 收到 Codex `project/changed`：仅使 Codex 工作区索引失效并拉取最新项目列表。
4. 打开工作区：缓存先显示，后台刷新第一页；下一页由滚动触发。
5. 会话执行、创建、删除或隐藏完成：只失效所属 Agent + workspaceId 的第一页。

## 重命名与路径变化

Codex 项目改名是名称变化，不是文件系统目录改名。通过稳定 `project.id` 保持同一工作区，更新 `name` 后保留已加载会话、展开状态和滚动位置。

Codex roots 更新时，以同一 `project.id` 更新当前根目录，并把旧 roots 放入该工作区的本地别名集合，用于关联旧线程。别名不显示，也不发回 Codex。

其他 Agent 如果提供稳定项目 ID，使用同样规则。只有路径而没有稳定 ID 的来源，路径变化不能被可靠证明为重命名；此时保留为两个工作区，避免误合并。

## 手工导入工作区

四个 Agent 都提供同一个“导入目录”入口。Customer Agent 继续写入自身项目仓储；Codex、Claude Code 与 OpenCode 写入 Broker 持有的独立导入工作区注册表，不污染 Customer Agent 的 `projects` 表，也不修改外部 Agent 的原生项目数据。

导入目录按 `agentType + 规范化绝对路径` 唯一。同一 Agent 下，如果路径已经存在于原生工作区 roots 或导入注册表中，接口返回已有工作区并标记 `existing: true`，展示层只提示“该文件夹已在当前 Agent 的目录中”、选中并展开已有目录，不重复创建。不同 Agent 可以分别导入同一路径。

外部 Agent 的导入工作区使用稳定的合成 workspace ID，排在该 Agent 原生工作区之后，并按首次导入时间保持顺序。读取会话时按真实 `cwd` 查询；创建 Codex 会话时只传 `cwd`，不得把合成 workspace ID 作为 `projectId` 发给 `thread/start`。返回给展示层的会话摘要仍投影到合成 workspace ID，以保持刷新前后的目录归属。

## 错误与竞态

- 工作区或会话刷新失败：保留旧内容，在对应区域展示轻量重试入口。
- Agent 不可用：切换器保留该 Agent，但标记不可用；若有缓存仍可浏览缓存。
- 工作区被删除：增量对账后移除该行；若当前选中会话仍存在，聊天内容不立即清空，但侧栏选择回到空状态。
- 改名与会话分页并发：分页结果按 `workspaceId` 合并，因此不会因名称变化丢页。
- 切换 Agent 与旧请求并发：每个 Agent/工作区请求代次独立，旧响应不得覆盖较新的选择和缓存。
- 缓存损坏或超额：忽略损坏分区；localStorage 写入失败不影响在线读取。

## 测试与验收

### 领域与应用服务

- 四个 Agent 的工作区身份、排序和分页契约。
- Codex 改名保持 workspaceId、会话页、展开状态和选择。
- Codex `position` 顺序逐项保持，不能被名称或活跃时间重排。
- per-Agent single-flight、缓存隔离、水位增量和旧响应丢弃。
- 路径最长匹配、旧 root 别名和无法证明时不合并。

### 适配器与接口

- Codex `project/list` 分页、`project/changed`、实验 API 失败回退。
- OpenCode 原生顺序与目录会话查询。
- Claude Code 分页归并目录并保持首次出现顺序。
- Customer Agent 项目顺序和会话摘要分页。
- Broker、Electron IPC、Web HTTP 与 Web gateway 参数和响应一致。

### 展示层

- Agent 切换只加载当前 Agent。
- 缓存立即显示，后台刷新不清空列表、不改变滚动位置。
- 工作区展开后才请求会话，滚动到底后追加下一页。
- 每个 Agent 独立恢复选择、展开、分页和滚动。
- 移除分组按钮后不存在 `groupByBot` 状态、分组节点或专属样式。
- 桌面宽度和 390×844 移动宽度均无文字溢出、遮挡或布局跳动。

### 完成标准

- 冷启动不再发现全部 Agent 会话。
- 第一次切换 Codex 只读取 Codex 工作区；展开一个 Codex 工作区只读取该目录第一页会话。
- Codex 改名和调序后 AgentRoam 在后台刷新周期内更新，目录身份和会话不丢失。
- 第二次切回任一 Agent 先展示缓存，再无感增量对账。
- 会话列表可持续滚动加载且无重复。
- 旧图片中高亮的 Agent 分组图标和分组功能完全删除。

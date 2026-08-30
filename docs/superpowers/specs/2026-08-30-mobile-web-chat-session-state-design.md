# Mobile Web Chat Session State Design

## Background

手机通过 `http://192.168.0.104:3100/app/` 打开 Web 聊天页后，会话标题和输入框正常显示，但聊天区域保持空态。发送消息时输入框会清空，实际请求链路也已完成：

- `GET /api/agent/stream?sessionId=...` 返回 200；
- `POST /api/agent/run` 返回 200；
- 用户消息和模型回复均已写入 SQLite 会话存储；
- 浏览器中的 `.chat-messages` 仍未渲染这些消息。

因此故障边界在前端会话状态协调，不在模型调用、SSE 接口或服务端持久化。

进一步核对发现，手机使用的是普通 HTTP 局域网地址。部分移动浏览器只在安全上下文提供 `crypto.randomUUID()`；当前会话恢复和发送路径在调用接口前直接使用该方法生成 UI 消息 id。方法缺失时，历史恢复异常被静默捕获，发送处理则在建立 stream 之前退出。这是手机端“历史空白且没有触发 stream/run”的直接原因。

## Goal

让 Web 聊天页在首次加载、首次发送、连续发送和会话切换后都只展示当前会话的最新消息，并保证服务端已返回的内容不会被过期异步任务清空或覆盖。

## Non-Goals

- 不修改 `/api/agent/run`、`/api/agent/stream` 或会话存储契约；
- 不重构桌面端整体消息 UI；
- 不调整模型配置、鉴权、隧道或移动端视觉样式；
- 不引入新的全局状态库或端到端测试框架。

## Design

### 0. Web UUID 兼容层

WebApp 在加载共享桌面 renderer 前安装 `crypto.randomUUID` 兼容实现。原生方法存在时保持不变；缺失时使用普通 HTTP 仍可用的 `crypto.getRandomValues` 生成 RFC 4122 v4 UUID。兼容层只从 WebApp 组合根启用，不改变 Electron 和服务端运行时。

### 1. 原子激活目标会话

普通文本发送在写入乐观用户消息前先解析目标会话：优先使用 `selectedSessionId`，其次使用当前 store 会话；会话 ID 必须先 `trim`，不存在、空串或纯空白时都先创建会话。创建接口返回的 ID 仍为空时立即报错，不能建立携带空 `sessionId` 的 SSE。

确定目标会话后，在继续执行任何异步回调前同步完成以下操作：

1. 更新用于事件路由的 `sessionIdRef`；
2. 更新 Zustand store 的 `sessionId`；
3. 使用显式 `sessionId` 写入乐观用户消息；
4. 新会话同时设置 running 标记，再通知父组件选中会话。

这样用户消息、SSE `text_chunk` 和完成事件从一开始就进入同一个消息桶，不依赖 React effect 稍后同步 ref。

### 2. 丢弃过期会话加载结果

`loadSelectedSession` 为每次加载分配单调递增的 generation。异步请求返回后，只有同时满足以下条件才允许写入 store：

- generation 仍是最新一次；
- 返回结果的 session id 仍等于当前选中会话；
- 当前会话没有更新的内存消息需要保留。

选中会话为空时也递增 generation，使之前仍在飞行中的请求自动失效。加载失败只清理仍然对应当前 generation 和当前会话的消息，不能清空用户已经切换到的其他会话。

### 3. 运行中优先保留实时消息

加载持久化历史时，如果目标会话正在运行且内存消息桶已有内容，继续使用内存版本；否则使用服务端恢复结果。运行结束后由现有 `onRunComplete` 刷新会话目录，不额外强制整页刷新。

## Data Flow

正常发送链路如下：

1. 用户点击发送；
2. 解析或创建目标 session；
3. 同步激活 session ref 和 store；
4. 用户消息写入目标消息桶并立即显示；
5. 建立 SSE stream；
6. 调用 run；
7. SSE 事件按 `_sid` 更新同一消息桶；
8. done 后刷新会话目录，保留当前聊天内容。

历史加载与发送并发时，generation 较旧的一方只能结束自身请求，不能再修改可见消息。

## Error Handling

- 创建会话失败：保留明确错误提示，不启动 SSE/run；
- SSE 或 run 失败：沿用现有错误事件和持久化恢复逻辑；
- 历史加载失败：仅在请求仍属于当前会话时清理该会话，不影响其他会话；
- 用户快速切换会话：旧加载结果被 generation 守卫丢弃。

## Verification

### Unit Tests

- 普通 HTTP 兼容层在缺少 `randomUUID` 时生成合法 v4 UUID，原生方法存在时不覆盖；
- 新会话发送的调用顺序为 create -> activate -> optimistic message -> parent callback -> run；
- 空串或纯空白 session id 按新会话处理，创建接口返回空 id 时不激活会话、不写乐观消息；
- 已有会话发送显式使用目标 session id；
- 旧 generation 不能覆盖新会话；
- 当前会话运行中且存在内存消息时优先保留实时消息；
- 旧请求失败不能清空新会话。

### Browser Verification

重新构建 WebApp 后，在 `390 x 844` 手机视口访问 `http://192.168.0.104:3100/app/`：

- 首屏恢复当前会话历史；
- 首次发送立即显示用户气泡；
- Network 中按顺序出现 stream 和 run；
- 模型文本流式进入聊天区；
- 刷新后历史仍可恢复；
- 快速切换两个会话不会串消息或回到空态。

## Rollout

改动限制在 ChatView 会话协调逻辑及相应纯函数测试。构建产物继续由现有 `packages/server/ws-server.mjs` 在 `/app/` 提供，不改变部署入口。

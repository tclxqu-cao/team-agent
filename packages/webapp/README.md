# @agent/webapp — Web 端壳模块

把桌面端(Electron)的完整聊天界面搬到浏览器/手机上，**不复制任何 UI 代码**，
复用两边的既有能力：

```
┌────────────────────────────────────────────────────────────────┐
│ presentation  @desktop/renderer(App/ChatView/stores) 原样复用   │
│               + web/webLayout.ts(flag 门控的响应式抽屉)         │
├────────────────────────────────────────────────────────────────┤
│ domain/ports  AgentApi 端口 —— 桌面 preload 与 web 网关实现同一  │
│               契约(ports & adapters)                           │
├────────────────────────────────────────────────────────────────┤
│ infrastructure(A本模块)                                       │
│   http/AgentHttpGateway   → /api/agent/* + /api/sessions/*     │
│                             (REST + SSE,事件带 _sid 路由)       │
│   http/HttpWebAuthService → /api/web-auth/*(登录/初始化)       │
│   local/*                 → localStorage(设置/智能体/LSP 桩)    │
├────────────────────────────────────────────────────────────────┤
│ server 能力复用  packages/server:AgentHost(@agent/core 进程内)  │
│                  + WS 网关(终端/文件)+ web-auth                │
└────────────────────────────────────────────────────────────────┘
```

## 分层职责

- **domain/ports** — `AgentApi` 端口(来自 `@desktop/renderer/global`，
  桌面 preload 的同一契约)。UI 只依赖端口，不感知传输。
- **infrastructure/http** — 端口的浏览器适配器：`run()` 先开 SSE 再发起
  运行（不丢早期事件），事件统一打 `_sid` 会话标签后转发给 UI 总线，
  `done/error/turn_aborted` 时收敛 run Promise，语义与桌面 IPC 一致。
- **infrastructure/local** — 服务器尚无对应能力的设置/智能体定义/LSP，
  以 localStorage 适配器兜底，保证设置类 UI 可用（仅本设备生效）。
- **src/main.tsx** — 组合根：web-auth 校验 → 登录页（如需）→ 绑定
  `window.agentApi` → 动态加载 `@desktop/renderer/App`。
- **presentation** — 仅 web 专属的登录页与壳样式；主体界面 100% 复用桌面端。

## 部署

`bun run --cwd packages/webapp build` 产出 `dist/`，由 packages/server 的
ws-server 以 `/app` 路径静态托管（可用 `AGENT_WEB_APP_DIST` 覆盖产物目录）。
未登录访问会被网关适配器引导到内建登录页（复用 /api/web-auth 会话 Cookie）。

## 当前边界（后续接入服务器即可消除）

- 项目列表是单个合成项目（server 尚无 project CRUD 路由）；
- 智能体定义/LSP/上传为本地兜底，不参与服务端运行；
- cron(`​/loop`)在 web 端只展示占位任务，不执行；
- TTS/语音唤醒走浏览器能力或禁用，native TTS 管线仅桌面端可用。

# TUI Steer、项目路由与稳定渲染 Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除长会话固定计时闪屏，支持把排队消息注入当前 ReAct turn，并从 Home 通过自然语言直接切换到本地项目，同时用等宽符号替代角色文字标签。

**Architecture:** 连续 `text_chunk` 由独立缓冲器按 80 ms 合并，非文本边界事件先 flush 再分发；TUI runtime 复用 Core 已有 `__steer__` session 协议。项目发现从 Home 改为一级仓库扫描并读取有限上下文前缀，本地导航解析器只处理高置信度“进入/切换/打开项目”请求。

**Tech Stack:** TypeScript、React 18、Ink 5、Bun、Vitest、`@agent/core` session/AgentLoop。

## Global Constraints

- 消息轨道只使用普通 Unicode 等宽符号，不依赖 Nerd Font，不使用 Emoji。
- 左侧消息、状态、队列和设置轨道统一为 3 列。
- 流式文本刷新间隔为 80 ms；任何非 `text_chunk` 事件到达前必须同步 flush。
- Home 项目发现只扫描一级目录；项目 metadata 只读取固定白名单文件前缀，不递归搜索。
- 未唯一命中的项目导航不能自动切换；无匹配时原消息继续交给 Agent。
- 普通 Enter 继续 FIFO 排队；只有 `/steer <序号>` 主动注入当前 turn。
- 不修改 Desktop 队列协议，不引入新的第三方依赖。
- 只提交本计划涉及的 TUI、必要 Core 文件和设计/计划文档，不带入其他脏文件。

---

### Task 1: 流式事件缓冲器与稳定状态行

**Files:**
- Create: `packages/tui/src/stream-buffer.ts`
- Create: `packages/tui/src/stream-buffer.test.ts`
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/components/ProgressLine.tsx`

**Interfaces:**
- Consumes: `AgentEvent` from `@agent/core`。
- Produces: `AgentEventBuffer`，构造函数 `(emit: (event: AgentEvent) => void, delayMs?: number)`；方法 `push(event)`, `flush()`, `dispose()`。

- [x] **Step 1: 实现 AgentEventBuffer**

连续正文合并，边界事件保持顺序：

```ts
export class AgentEventBuffer {
  constructor(private readonly emit: (event: AgentEvent) => void, private readonly delayMs = 80) {}
  push(event: AgentEvent): void;
  flush(): void;
  dispose(): void;
}
```

`push(text_chunk)` 追加文本并只保留一个 timer；其他事件先 `flush()` 再 `emit(event)`。`dispose()` 清理 timer 并 flush，确保最后正文不丢失。

- [x] **Step 2: 接入 App 的 runtime event callback**

每个 turn 创建一个 buffer，buffer 的 emit 回调执行现有 reducer dispatch。`runtime.run()` 返回或抛错前后都要 flush/dispose；错误事件必须排在已积压正文之后。

- [x] **Step 3: 移除 ProgressLine 固定 interval**

删除 `useEffect/useState/setInterval`。进行中耗时只在实际父组件重绘时用 `Date.now()` 计算，不主动制造额外重绘。

- [x] **Step 4: 添加缓冲顺序测试**

使用 fake timers 验证多个 chunk 在 80 ms 后合成一个事件；tool/done 到达时正文立即先发；dispose 不丢正文且不会二次触发。

### Task 2: 当前 turn 的 `/steer` 注入

**Files:**
- Modify: `packages/tui/src/runtime.ts`
- Modify: `packages/tui/src/runtime.test.ts`
- Modify: `packages/tui/src/commands.ts`
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/App.test.tsx`
- Modify: `packages/tui/src/components/MessageQueue.tsx`

**Interfaces:**
- Consumes: 当前 `sessionStore`, `currentSessionId`, `queuedInputsRef`。
- Produces: `TuiRuntime.steer(input: string): Promise<void>`；内置命令 `/steer <queue-index>`。

- [x] **Step 1: 为 TuiRuntime 增加 steer()**

```ts
async steer(input: string): Promise<void> {
  if (!this.agent || !this.currentSessionId) throw new Error("Agent 尚未初始化");
  await this.sessionStore.addMessage(this.currentSessionId, {
    role: "user",
    content: input,
    name: "__steer__",
  });
}
```

- [x] **Step 2: 注册 `/steer` 命令并实现序号校验**

新增命令描述“将排队消息插入当前轮”。仅在 `state.running` 时允许；参数必须是 1 开始的整数且不能超过队列长度。

- [x] **Step 3: 成功后移除队列消息**

先 `await runtime.steer(message)`，成功后再 `splice(index, 1)`、同步 React queue state，并向 Transcript 追加 user entry。失败时保留队列并显示 error。

- [x] **Step 4: 更新队列提示**

队列底部显示 `/steer 1 插入本轮`，让命令行用户无需猜测操作。

- [x] **Step 5: 添加 runtime 和组件测试**

验证 session message 的 `name` 为 `__steer__`；验证第一条被注入、第二条仍排队；验证越界、未运行和 runtime 拒绝不会丢队列。

### Task 3: Home 项目发现与自然语言项目路由

**Files:**
- Modify: `packages/tui/src/resources.ts`
- Modify: `packages/tui/src/resources.test.ts`
- Modify: `packages/tui/src/palette.ts`
- Create: `packages/tui/src/project-routing.ts`
- Create: `packages/tui/src/project-routing.test.ts`
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Consumes: `ProjectCandidate[]`，每项 `metadata.searchText` 包含有限项目上下文。
- Produces: `resolveProjectNavigation(input, projects)`，返回 `none | match | ambiguous`。

- [x] **Step 1: 修正 Home 扫描根目录**

`scanSiblingProjects(cwd, { homeDirectory? })` 在 cwd 等于 Home 时扫描 cwd 一级子目录；其他 cwd 继续扫描父目录。只接受已有 project marker 的目录。

- [x] **Step 2: 建立有限项目搜索文本**

为每个项目最多读取以下文件各 8 KiB：`README.md`、`docs/project-context.md`、`AGENTS.md`、`CLAUDE.md`。把 label、path 和读取到的前缀存到 `metadata.searchText`，读取失败静默跳过。

- [x] **Step 3: 让 palette 搜索 metadata**

`score()` 在 label/value/description 未命中后检查 `metadata.searchText`，使 `/projects 赔付` 和 `@赔付` 能发现 `refund`。

- [x] **Step 4: 实现本地导航解析器**

```ts
export type ProjectNavigation =
  | { type: "none" }
  | { type: "match"; project: ProjectCandidate }
  | { type: "ambiguous"; query: string; projects: ProjectCandidate[] };

export function resolveProjectNavigation(input: string, projects: readonly ProjectCandidate[]): ProjectNavigation;
```

只匹配含 `进入|切换到|打开|前往|定位到` 与 `项目|目录|仓库` 的输入。label/path 精确或包含优先，其次按 metadata 中查询词出现次数排序；最高分唯一才返回 match。

- [x] **Step 5: 在非运行状态提交前执行本地路由**

唯一命中直接调用现有 `switchProject()`；多命中打开只包含候选项目的 projects palette；无命中继续现有 Agent 流程。运行中输入仍按队列规则处理。

- [x] **Step 6: 添加 Home、中文项目和回退测试**

临时 Home 下创建 `refund/.git` 和 `refund/docs/project-context.md`，正文包含“客服赔付域”。验证只扫描一级仓库、中文请求命中 refund、多候选不自动切换、普通问题返回 none。

### Task 4: 等宽符号角色轨道

**Files:**
- Modify: `packages/tui/src/theme.ts`
- Modify: `packages/tui/src/components/Transcript.tsx`
- Modify: `packages/tui/src/components/ProgressLine.tsx`
- Modify: `packages/tui/src/components/MessageQueue.tsx`
- Modify: `packages/tui/src/components/ModelWizard.tsx`
- Modify: `packages/tui/src/App.test.tsx`

**Interfaces:**
- Consumes: 现有 `TUI_THEME` 语义色。
- Produces: `ROLE_GLYPHS` 常量，包含 `user`, `assistant`, `tool`, `result`, `notice`, `error`, `progress`, `queue`, `setup`。

- [x] **Step 1: 定义符号映射**

```ts
export const ROLE_GLYPHS = {
  user: "›", assistant: "◆", tool: "⚙", result: "↳",
  notice: "i", error: "!", progress: "●", queue: "≡", setup: "◇",
} as const;
```

- [x] **Step 2: 替换组件标签并统一轨道宽度**

Transcript、Progress、Queue、ModelWizard 的左栏统一 `width={3}`。完成状态允许使用 `✓`，正文不再重复输出 `●`。

- [x] **Step 3: 更新渲染断言**

组件测试不再查找 `YOU/AGENT/TOOL/RESULT/QUEUE/STATE/SETUP`，改为验证对应符号与正文相邻且长输出仍存在。

### Task 5: 文档、完整验证与推送准备

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-tui-steer-project-routing-and-rendering.md`
- Verify only: `packages/tui/**`, `packages/core/**`

**Interfaces:**
- Consumes: Tasks 1-4 的最终代码和测试。
- Produces: 可推送的聚焦 diff 与真实 PTY 证据。

- [x] **Step 1: 逐项勾选实施计划**

实现完成后把本计划已完成步骤改为 `[x]`，保持计划与实际文件一致。

- [x] **Step 2: 执行真实 PTY 验证**

从 `/Users/caoqu` 启动 `agent-tui`，验证图标轨道、项目自然语言切换、队列显示与 `/steer 1`。使用可控 mock Agent/PTY 捕获验证长工具等待期间没有 250 ms 周期写入。

- [x] **Step 3: 检查 Git 范围**

使用显式路径检查和暂存，只包含本次 TUI 文件、相关测试、设计与计划；保留所有无关脏文件。

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/tui/src`
Expected: 现有和新增 TUI tests 全部 PASS。

Run: `bunx tsc --noEmit -p packages/tui/tsconfig.json`
Expected: PASS，无 TypeScript diagnostics。

Run: `bunx tsc --noEmit -p packages/core/tsconfig.json`
Expected: PASS，无 TypeScript diagnostics。

Run: `bun run --cwd packages/core build`
Expected: PASS。

Run: `git diff --check -- packages/tui docs/superpowers/specs/2026-08-28-tui-steer-project-routing-and-rendering-design.md docs/superpowers/plans/2026-08-28-tui-steer-project-routing-and-rendering.md`
Expected: 无输出，退出码 0。

任何命令失败时修复实现或测试并重新运行，直到通过；最终回复报告实际命令与结果。

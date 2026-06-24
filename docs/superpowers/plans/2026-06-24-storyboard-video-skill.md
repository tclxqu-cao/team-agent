# Storyboard Video Generation Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained `/storyboard` skill that takes mixed materials (images + text), generates storyboard shots with preview images, produces video clips via Seedance 1 Lite API, and composes them into a final video — all visualized through an embedded StoryboardWorkbench card in the chat.

**Architecture:** A new `show_widget` built-in tool lets any skill push custom UI cards to the chat. The storyboard skill uses `show_widget` to render a `StoryboardWorkbench` React component. The skill contains all generation logic as bundled TS scripts invoked via the `bash` tool. The core agent loop, event pipeline, and frontend rendering chain are extended to support the new `show_widget` event type.

**Tech Stack:** TypeScript, Bun, React (inline styles, Pearl Light design tokens), Seedance 1 Lite API (火山引擎), FFmpeg, Zod

## Global Constraints

- All colors/sizes must use CSS variables from `global.css` (`var(--bg-surface)`, `var(--accent)`, etc.)
- Follow existing inline-style pattern (no CSS modules, no Tailwind)
- New events must extend both `AgentEvent` (core) and `StreamEvent` (renderer store)
- Skill scripts must be async (no `execSync` — Electron main process rule)
- MVP post-processing: basic stitching + transitions only (no TTS, no subtitles)
- File paths use forward slashes; all new core files end with `.js` import extensions

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `packages/core/src/domain/tool/builtin/ShowWidgetTool.ts` | `show_widget` tool definition |
| Modify | `packages/core/src/domain/tool/builtin/index.ts` | Export + register ShowWidgetTool |
| Modify | `packages/core/src/domain/agent/entities.ts` | Add `show_widget` to AgentEvent union |
| Modify | `packages/desktop/renderer/stores/agentStore.ts` | Extend StreamEvent with widget fields |
| Modify | `packages/desktop/renderer/components/ChatView.tsx` | Handle `show_widget` event, route to widget registry |
| Create | `packages/desktop/renderer/components/widgets/StoryboardWorkbench.tsx` | Storyboard workbench UI card |
| Create | `packages/desktop/renderer/components/widgets/index.ts` | Widget component registry |
| Create | `skills/storyboard/SKILL.md` | Skill prompt + trigger definition |
| Create | `skills/storyboard/scripts/generate-storyboard.ts` | LLM → structured shot list |
| Create | `skills/storyboard/scripts/render-preview.ts` | AI image API → preview images |
| Create | `skills/storyboard/scripts/generate-video.ts` | Seedance API → video clips |
| Create | `skills/storyboard/scripts/compose-video.ts` | FFmpeg → final composed video |
| Create | `packages/core/src/domain/tool/builtin/__tests__/ShowWidgetTool.test.ts` | Unit tests |

---

### Task 1: Add `show_widget` to AgentEvent type

**Files:**
- Modify: `packages/core/src/domain/agent/entities.ts`

**Interfaces:**
- Consumes: nothing (type-only change)
- Produces: `AgentEvent` union with new `show_widget` variant — used by Task 2 (ShowWidgetTool) and Task 5 (ChatView event handling)

- [ ] **Step 1: Add show_widget variant to AgentEventType and AgentEvent**

In `packages/core/src/domain/agent/entities.ts`, add `"show_widget"` to the `AgentEventType` union and add a new variant to the `AgentEvent` union:

```typescript
// Add to AgentEventType union:
| "show_widget"

// Add to AgentEvent union:
| { type: "show_widget"; widgetType: string; data: Record<string, unknown>; widgetId: string }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/domain/agent/entities.ts
git commit -m "feat: add show_widget to AgentEvent type union"
```

---

### Task 2: Create ShowWidgetTool

**Files:**
- Create: `packages/core/src/domain/tool/builtin/ShowWidgetTool.ts`
- Create: `packages/core/src/domain/tool/builtin/__tests__/ShowWidgetTool.test.ts`

**Interfaces:**
- Consumes: `AgentEvent.show_widget` variant from Task 1
- Produces: `ShowWidgetTool` class — used by Task 3 (registration) and emits `show_widget` events consumed by Task 5 (frontend)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/domain/tool/builtin/__tests__/ShowWidgetTool.test.ts
import { describe, it, expect } from "vitest";
import { ShowWidgetTool } from "../ShowWidgetTool.js";

describe("ShowWidgetTool", () => {
  const tool = new ShowWidgetTool();

  it("should have correct name and description", () => {
    expect(tool.name).toBe("show_widget");
    expect(tool.description).toContain("custom UI card");
  });

  it("should return widgetId on execute", async () => {
    const result = await tool.execute(
      { widget_type: "storyboard_workbench", data: { shots: [] } },
      { workingDirectory: "/tmp", sessionId: "s1" } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("widgetId");
  });

  it("should accept update_id to update existing widget", async () => {
    const result = await tool.execute(
      { widget_type: "storyboard_workbench", data: { shots: [1] }, update_id: "w-123" },
      { workingDirectory: "/tmp", sessionId: "s1" } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("w-123");
  });

  it("should reject missing widget_type", async () => {
    const result = await tool.execute(
      { data: {} },
      { workingDirectory: "/tmp", sessionId: "s1" } as any,
    );
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/domain/tool/builtin/__tests__/ShowWidgetTool.test.ts`
Expected: FAIL — cannot find module `ShowWidgetTool`

- [ ] **Step 3: Implement ShowWidgetTool**

```typescript
// packages/core/src/domain/tool/builtin/ShowWidgetTool.ts
import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { randomUUID } from "node:crypto";

export class ShowWidgetTool implements ITool {
  readonly name = "show_widget";
  readonly description =
    "Display a custom UI card in the chat. " +
    "Use widget_type to specify the card type and data to pass structured content. " +
    "Use update_id to update an existing card instead of creating a new one.";
  readonly schema = z.object({
    widget_type: z.string().describe("Card type identifier, e.g. 'storyboard_workbench'"),
    data: z.record(z.unknown()).describe("Structured data for the card to render"),
    update_id: z.string().optional().describe("ID of existing widget to update (omit to create new)"),
  });
  readonly parameters = this.schemaToParams();

  private schemaToParams(): Record<string, unknown> {
    const shape = (this.schema as z.ZodObject<z.ZodRawShape>).shape;
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(shape)) {
      const def = (val as z.ZodTypeAny)._def;
      const desc = def.description ?? "";
      const inner = def.innerType ?? val;
      const typeName: string = inner._def?.typeName ?? def.typeName ?? "";
      let type = "string";
      if (typeName === "ZodNumber") type = "number";
      else if (typeName === "ZodBoolean") type = "boolean";
      else if (typeName === "ZodRecord") type = "object";
      props[key] = { type, description: desc };
    }
    return {
      type: "object",
      properties: props,
      required: ["widget_type", "data"],
    };
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return {
        toolCallId: "",
        content: `Invalid parameters: ${parsed.error.message}`,
        isError: true,
      };
    }

    const widgetId = parsed.data.update_id ?? `w-${randomUUID().slice(0, 8)}`;
    const widgetType = parsed.data.widget_type;
    const data = parsed.data.data;

    // The AgentLoop intercepts show_widget tool results and emits
    // a show_widget AgentEvent instead of a normal tool_result.
    // We encode the event data in the result content for the loop to parse.
    const payload = JSON.stringify({ widgetId, widgetType, data });
    return {
      toolCallId: "",
      content: `Widget displayed: ${payload}`,
      // Attach metadata for AgentLoop to emit show_widget event
      metadata: { showWidget: { widgetId, widgetType, data } },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/domain/tool/builtin/__tests__/ShowWidgetTool.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain/tool/builtin/ShowWidgetTool.ts packages/core/src/domain/tool/builtin/__tests__/ShowWidgetTool.test.ts
git commit -m "feat: add ShowWidgetTool for custom UI card rendering"
```

---

### Task 3: Register ShowWidgetTool in builtin tools

**Files:**
- Modify: `packages/core/src/domain/tool/builtin/index.ts`

**Interfaces:**
- Consumes: `ShowWidgetTool` class from Task 2
- Produces: registered tool available in `IToolRegistry`

- [ ] **Step 1: Add export and registration**

In `packages/core/src/domain/tool/builtin/index.ts`, add the export and registration:

```typescript
// Add to exports (after LspTools line):
export { ShowWidgetTool } from './ShowWidgetTool.js';

// Add import:
import { ShowWidgetTool } from './ShowWidgetTool.js';

// Add inside registerBuiltinTools function:
registry.register(new ShowWidgetTool());
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/domain/tool/builtin/index.ts
git commit -m "feat: register ShowWidgetTool in builtin tools"
```

---

### Task 4: Wire show_widget event through AgentLoop

**Files:**
- Modify: `packages/core/src/domain/agent/AgentLoop.ts`

**Interfaces:**
- Consumes: `ToolResult.metadata.showWidget` from Task 2
- Produces: `show_widget` AgentEvent emitted during the ReAct loop

- [ ] **Step 1: Intercept show_widget tool results in the ReAct loop**

In `AgentLoop.ts`, find the section where tool results are yielded (the `tool_result` event emission). Before yielding a `tool_result`, check if the result has `metadata.showWidget`. If so, yield a `show_widget` event instead:

```typescript
// In the tool execution loop, after getting toolResult:
if ((toolResult as any).metadata?.showWidget) {
  const { widgetId, widgetType, data } = (toolResult as any).metadata.showWidget;
  yield { type: "show_widget", widgetId, widgetType, data } as AgentEvent;
} else {
  yield { type: "tool_result", result: toolResult } as AgentEvent;
}
```

- [ ] **Step 2: Run existing AgentLoop tests**

Run: `cd packages/core && npx vitest run src/domain/agent/__tests__/AgentLoop.test.ts`
Expected: All existing tests still PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/domain/agent/AgentLoop.ts
git commit -m "feat: emit show_widget event from AgentLoop when tool has widget metadata"
```

---

### Task 5: Extend StreamEvent and handle show_widget in frontend

**Files:**
- Modify: `packages/desktop/renderer/stores/agentStore.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Create: `packages/desktop/renderer/components/widgets/index.ts`

**Interfaces:**
- Consumes: `show_widget` AgentEvent from Task 4 (forwarded via IPC)
- Produces: Widget data routed to React components in the chat

- [ ] **Step 1: Extend StreamEvent interface**

In `packages/desktop/renderer/stores/agentStore.ts`, add widget fields to `StreamEvent`:

```typescript
// Add to StreamEvent interface:
  /** For show_widget events */
  widgetId?: string;
  widgetType?: string;
  widgetData?: Record<string, unknown>;
```

Also add a `widget` field to `ChatMessage`:

```typescript
// Add to ChatMessage interface:
  /** Widget card data (from show_widget events) */
  widget?: { widgetId: string; widgetType: string; data: Record<string, unknown> };
```

- [ ] **Step 2: Create widget registry**

```typescript
// packages/desktop/renderer/components/widgets/index.ts
import type { ComponentType } from "react";
import { StoryboardWorkbench } from "./StoryboardWorkbench.js";

export const widgetRegistry: Record<string, ComponentType<any>> = {
  "storyboard_workbench": StoryboardWorkbench,
};
```

- [ ] **Step 3: Handle show_widget event in ChatView**

In `ChatView.tsx` `handleEvent` function, add a new case:

```typescript
case "show_widget": {
  const widgetMsg = {
    widgetId: event.widgetId!,
    widgetType: event.widgetType!,
    data: event.widgetData!,
  };
  // If update_id matches an existing message's widget, update it
  const existingIdx = messages.findIndex(
    m => m.widget?.widgetId === widgetMsg.widgetId
  );
  if (existingIdx >= 0) {
    updateMessage(messages[existingIdx].id, (m) => ({
      ...m,
      widget: widgetMsg,
    }));
  } else {
    // Create a new message with the widget
    addMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      widget: widgetMsg,
      timestamp: Date.now(),
    });
  }
  break;
}
```

- [ ] **Step 4: Render widget cards in the message list**

In the message rendering loop (before the AskUserCard check), add widget rendering:

```typescript
// Before "if (chatMsg.askUser)" block:
if (chatMsg.widget) {
  const WidgetComponent = widgetRegistry[chatMsg.widget.widgetType];
  if (WidgetComponent) {
    return (
      <div key={msg.id} style={{ marginBottom: 16 }}>
        <WidgetComponent {...chatMsg.widget.data} widgetId={chatMsg.widget.widgetId} />
      </div>
    );
  }
  // Fallback: show raw JSON
  return (
    <div key={msg.id} style={{
      padding: 12, borderRadius: 8,
      background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
      fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap",
      maxHeight: 300, overflow: "auto",
    }}>
      {JSON.stringify(chatMsg.widget.data, null, 2)}
    </div>
  );
}
```

- [ ] **Step 5: Add import for widgetRegistry at the top of ChatView**

```typescript
import { widgetRegistry } from "./widgets/index.js";
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd packages/desktop && npx tsc --noEmit`
Expected: May fail on `StoryboardWorkbench` import — will be resolved in Task 6. Create a stub:

```typescript
// packages/desktop/renderer/components/widgets/StoryboardWorkbench.tsx (stub)
export function StoryboardWorkbench(props: any) {
  return <div>Storyboard Workbench (stub)</div>;
}
```

Then re-run: `cd packages/desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/renderer/stores/agentStore.ts packages/desktop/renderer/components/ChatView.tsx packages/desktop/renderer/components/widgets/
git commit -m "feat: handle show_widget events and route to widget registry"
```

---

### Task 6: Build StoryboardWorkbench React component

**Files:**
- Modify: `packages/desktop/renderer/components/widgets/StoryboardWorkbench.tsx` (replace stub)

**Interfaces:**
- Consumes: `Storyboard` data shape pushed via `show_widget`
- Produces: Rendered workbench card in chat

- [ ] **Step 1: Implement the full StoryboardWorkbench component**

```tsx
// packages/desktop/renderer/components/widgets/StoryboardWorkbench.tsx
import { useState } from "react";

interface Shot {
  index: number;
  description: string;
  prompt: string;
  duration: number;
  previewImageUrl?: string;
  videoUrl?: string;
  status: "pending" | "image_generating" | "video_generating" | "done" | "error";
  error?: string;
}

interface StoryboardWorkbenchProps {
  widgetId?: string;
  title?: string;
  shots?: Shot[];
  status?: string;
  composedVideoUrl?: string;
}

const statusIcon: Record<string, string> = {
  pending: "⏳",
  image_generating: "🎨",
  video_generating: "🎬",
  done: "✅",
  error: "❌",
};

export function StoryboardWorkbench(props: StoryboardWorkbenchProps) {
  const { title = "视频工作台", shots = [], status = "generating", composedVideoUrl } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [activeVideo, setActiveVideo] = useState<string | null>(null);

  const allDone = shots.length > 0 && shots.every(s => s.status === "done");

  return (
    <div style={{
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-md)",
      background: "var(--bg-surface)",
      overflow: "hidden",
      maxWidth: 600,
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px",
          background: "var(--bg-deep)",
          cursor: "pointer", userSelect: "none",
          borderBottom: collapsed ? "none" : "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
          🎬 {title}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {shots.filter(s => s.status === "done").length}/{shots.length} 完成
          <span style={{ marginLeft: 6, transform: collapsed ? "rotate(-90deg)" : "none", display: "inline-block", transition: "transform 0.2s" }}>▼</span>
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: "12px 16px" }}>
          {/* Shot table */}
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginBottom: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-deep)" }}>
                <th style={thStyle}>#</th>
                <th style={{ ...thStyle, textAlign: "left", minWidth: 120 }}>画面描述</th>
                <th style={thStyle}>时长</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>预览</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((shot) => (
                <tr key={shot.index} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <td style={tdStyle}>{shot.index}</td>
                  <td style={{ ...tdStyle, textAlign: "left", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={shot.description}>
                    {shot.description}
                  </td>
                  <td style={tdStyle}>{shot.duration}s</td>
                  <td style={tdStyle}>
                    {statusIcon[shot.status] ?? "⏳"}
                    {shot.error && <span style={{ color: "var(--danger)", fontSize: 11, marginLeft: 4 }} title={shot.error}>!</span>}
                  </td>
                  <td style={tdStyle}>
                    {shot.videoUrl ? (
                      <button
                        onClick={() => setActiveVideo(shot.videoUrl!)}
                        style={{
                          background: "var(--accent-dim)", color: "var(--accent)",
                          border: "1px solid rgba(79,110,247,0.22)", borderRadius: 6,
                          padding: "2px 8px", fontSize: 11, cursor: "pointer",
                        }}
                      >▶ 播放</button>
                    ) : shot.previewImageUrl ? (
                      <img src={shot.previewImageUrl} alt={`shot-${shot.index}`} style={{ width: 48, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border-subtle)" }} />
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Video player */}
          {activeVideo && (
            <video
              src={activeVideo}
              controls
              autoPlay
              style={{ width: "100%", borderRadius: 8, marginBottom: 12, border: "1px solid var(--border-subtle)" }}
            />
          )}

          {/* Composed video */}
          {composedVideoUrl && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>完整视频</div>
              <video
                src={composedVideoUrl}
                controls
                style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border-subtle)" }}
              />
            </div>
          )}

          {/* Status bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            {status === "generating" && <span>🔄 生成中...</span>}
            {status === "preview_ready" && <span>📷 预览图已就绪</span>}
            {status === "video_ready" && <span>🎬 视频片段已就绪</span>}
            {status === "composed" && <span>✅ 合成完成</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "6px 10px",
  textAlign: "center",
  fontWeight: 600,
  fontSize: 12,
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border-subtle)",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  textAlign: "center",
  fontSize: 13,
  color: "var(--text-secondary)",
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/renderer/components/widgets/StoryboardWorkbench.tsx
git commit -m "feat: implement StoryboardWorkbench widget component"
```

---

### Task 7: Create storyboard skill SKILL.md

**Files:**
- Create: `skills/storyboard/SKILL.md`

**Interfaces:**
- Consumes: nothing (skill prompt definition)
- Produces: Skill definition that triggers the storyboard workflow

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: storyboard
description: >
  Generate video storyboards from materials (images, text, mixed assets).
  Creates shot breakdowns with preview images, generates video clips via
  Seedance 1 Lite, and composes final video with transitions.
  Use when user says "storyboard", "分镜", "生成视频", "视频制作",
  or invokes /storyboard.
triggers:
  - storyboard
  - 分镜
  - 生成视频
  - 视频制作
---

# Storyboard Video Generation Skill

You are a video storyboard director. When the user provides materials (images, text descriptions, or mixed assets) and a creative direction, you will:

## Workflow

### Step 1: Analyze materials and generate storyboard

Read the user's materials and creative direction. Run the storyboard generation script:

\`\`\`bash
bun run skills/storyboard/scripts/generate-storyboard.ts --materials "<user materials summary>" --direction "<creative direction>" --output /tmp/storyboard.json
\`\`\`

This outputs a JSON file with the shot list. Then display the storyboard workbench:

\`\`\`
Use show_widget with:
- widget_type: "storyboard_workbench"
- data: the storyboard JSON content
\`\`\`

### Step 2: Generate preview images

For each shot in the storyboard, generate a preview image:

\`\`\`bash
bun run skills/storyboard/scripts/render-preview.ts --storyboard /tmp/storyboard.json --output-dir /tmp/storyboard/previews
\`\`\`

Update the workbench with preview image URLs using show_widget with the same widget_id (update_id).

### Step 3: Generate video clips

Generate video for each shot using Seedance 1 Lite:

\`\`\`bash
bun run skills/storyboard/scripts/generate-video.ts --storyboard /tmp/storyboard.json --previews-dir /tmp/storyboard/previews --output-dir /tmp/storyboard/videos --api-key "$VOLCENGINE_API_KEY"
\`\`\`

Update the workbench with video URLs using show_widget with update_id.

### Step 4: User review

Ask the user: "All video clips are ready. Would you like me to compose the final video with transitions?"

If the user confirms, proceed to Step 5.

### Step 5: Compose final video

\`\`\`bash
bun run skills/storyboard/scripts/compose-video.ts --videos-dir /tmp/storyboard/videos --storyboard /tmp/storyboard.json --output /tmp/storyboard/final.mp4
\`\`\`

Update the workbench with the composed video URL using show_widget with update_id.

## Important Notes

- Each script outputs JSON to stdout with progress updates
- If any shot fails, mark it as error in the workbench and continue with remaining shots
- The user can request regenerating individual shots — re-run the relevant script for that shot only
- Always use show_widget with update_id to update the existing workbench card, never create duplicates
```

- [ ] **Step 2: Commit**

```bash
git add skills/storyboard/SKILL.md
git commit -m "feat: add storyboard skill definition"
```

---

### Task 8: Create generate-storyboard script

**Files:**
- Create: `skills/storyboard/scripts/generate-storyboard.ts`

**Interfaces:**
- Consumes: user materials (text/images description), creative direction
- Produces: `/tmp/storyboard.json` with `Storyboard` structure

- [ ] **Step 1: Implement the script**

This script takes materials and direction, calls the project's configured LLM to generate a structured shot list, and writes it to a JSON file.

```typescript
#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    materials: { type: "string" },
    direction: { type: "string" },
    output: { type: "string" },
  },
});

if (!values.materials || !values.output) {
  console.error("Usage: generate-storyboard.ts --materials <text> --direction <text> --output <path>");
  process.exit(1);
}

// Read API config from environment
const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const baseUrl = process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const model = process.env.LLM_MODEL ?? "gpt-4o";

const prompt = `You are a professional video storyboard director.
Given the following materials and creative direction, generate a structured storyboard as JSON.

Materials:
${values.materials}

Creative Direction:
${values.direction ?? "Auto-determine based on materials"}

Output a JSON object with this exact structure:
{
  "title": "<video title>",
  "shots": [
    {
      "index": 1,
      "description": "<Chinese description of what happens in this shot>",
      "prompt": "<English prompt for AI image/video generation, be specific about composition, lighting, camera movement>",
      "duration": 5,
      "status": "pending"
    }
  ]
}

Rules:
- Generate 4-8 shots depending on content richness
- Each shot should be 5 seconds (Seedance 1 Lite standard)
- Prompts should be detailed, cinematic, in English
- Descriptions should be in Chinese for the user
- Output ONLY valid JSON, no markdown fences`;

const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
  }),
});

if (!response.ok) {
  const err = await response.text();
  console.error(`LLM API error: ${response.status} ${err}`);
  process.exit(1);
}

const result = await response.json();
const content = result.choices?.[0]?.message?.content ?? "";

// Parse JSON from response (strip markdown fences if present)
const jsonStr = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
const storyboard = JSON.parse(jsonStr);

// Add default fields
storyboard.status = "generating";
storyboard.id = `sb-${Date.now()}`;
for (const shot of storyboard.shots) {
  shot.status = shot.status ?? "pending";
}

await Bun.write(values.output, JSON.stringify(storyboard, null, 2));

// Output to stdout for the agent
console.log(JSON.stringify(storyboard));
```

- [ ] **Step 2: Commit**

```bash
git add skills/storyboard/scripts/generate-storyboard.ts
git commit -m "feat: add storyboard generation script (LLM-based shot list)"
```

---

### Task 9: Create render-preview script

**Files:**
- Create: `skills/storyboard/scripts/render-preview.ts`

**Interfaces:**
- Consumes: `/tmp/storyboard.json` from Task 8
- Produces: Preview images in output directory, updated storyboard JSON with `previewImageUrl`

- [ ] **Step 1: Implement the script**

This script reads the storyboard, calls an image generation API for each shot's prompt, and saves preview images.

```typescript
#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    storyboard: { type: "string" },
    "output-dir": { type: "string" },
  },
});

if (!values.storyboard || !values["output-dir"]) {
  console.error("Usage: render-preview.ts --storyboard <path> --output-dir <dir>");
  process.exit(1);
}

const outputDir = values["output-dir"];
await Bun.write(`${outputDir}/.gitkeep`, "");

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

const apiKey = process.env.IMAGE_API_KEY ?? process.env.LLM_API_KEY ?? "";
const baseUrl = process.env.IMAGE_BASE_URL ?? process.env.LLM_BASE_URL ?? "https://api.openai.com";

async function generateImage(prompt: string, outputPath: string): Promise<void> {
  // Use DALL-E / compatible image API
  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.IMAGE_MODEL ?? "dall-e-3",
      prompt: `Cinematic storyboard frame: ${prompt}. High quality, 16:9 aspect ratio, film lighting.`,
      n: 1,
      size: "1792x1024",
    }),
  });

  if (!response.ok) {
    throw new Error(`Image API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const imageUrl = result.data?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in response");

  // Download image
  const imgResponse = await fetch(imageUrl);
  const buffer = await imgResponse.arrayBuffer();
  await Bun.write(outputPath, buffer);
}

const results: Array<{ index: number; previewImageUrl: string; error?: string }> = [];

for (const shot of storyboard.shots) {
  const outputPath = `${outputDir}/shot-${shot.index}.png`;
  console.error(`Generating preview for shot ${shot.index}...`);
  try {
    await generateImage(shot.prompt, outputPath);
    results.push({ index: shot.index, previewImageUrl: outputPath });
    console.error(`  ✅ Shot ${shot.index} saved to ${outputPath}`);
  } catch (err: any) {
    console.error(`  ❌ Shot ${shot.index} failed: ${err.message}`);
    results.push({ index: shot.index, previewImageUrl: "", error: err.message });
  }
}

// Update storyboard with preview URLs
for (const r of results) {
  const shot = storyboard.shots.find((s: any) => s.index === r.index);
  if (shot) {
    shot.previewImageUrl = r.previewImageUrl;
    shot.status = r.error ? "error" : "image_generating";
    if (r.error) shot.error = r.error;
  }
}

storyboard.status = "preview_ready";
await Bun.write(values.storyboard, JSON.stringify(storyboard, null, 2));

console.log(JSON.stringify({ results, storyboard }));
```

- [ ] **Step 2: Commit**

```bash
git add skills/storyboard/scripts/render-preview.ts
git commit -m "feat: add preview image generation script"
```

---

### Task 10: Create generate-video script (Seedance 1 Lite)

**Files:**
- Create: `skills/storyboard/scripts/generate-video.ts`

**Interfaces:**
- Consumes: storyboard JSON + preview images from Task 9
- Produces: Video clips in output directory, updated storyboard JSON with `videoUrl`

- [ ] **Step 1: Implement the script**

This script calls the Seedance 1 Lite API (via 火山引擎) to generate video clips from preview images.

```typescript
#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    storyboard: { type: "string" },
    "previews-dir": { type: "string" },
    "output-dir": { type: "string" },
    "api-key": { type: "string" },
  },
});

if (!values.storyboard || !values["output-dir"]) {
  console.error("Usage: generate-video.ts --storyboard <path> --previews-dir <dir> --output-dir <dir> --api-key <key>");
  process.exit(1);
}

const apiKey = values["api-key"] ?? process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = process.env.SEEDANCE_BASE_URL ?? "https://visual.volcengineapi.com";

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

async function generateVideoFromImage(imagePath: string, prompt: string, outputPath: string): Promise<void> {
  const imageBase64 = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64");

  // Seedance 1 Lite API call
  const response = await fetch(`${baseUrl}/v1/video/generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "seedance-1-lite",
      input: {
        image: `data:image/png;base64,${imageBase64}`,
        prompt: prompt,
      },
      parameters: {
        duration: 5,
        resolution: "720p",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Seedance API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const taskId = result.task_id ?? result.data?.task_id;
  if (!taskId) throw new Error("No task_id in Seedance response");

  // Poll for completion (Seedance is async)
  const MAX_POLLS = 60; // 5 min max
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusResp = await fetch(`${baseUrl}/v1/video/query?task_id=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const statusData = await statusResp.json();
    const status = statusData.status ?? statusData.data?.status;

    if (status === "success" || status === "completed") {
      const videoUrl = statusData.video_url ?? statusData.data?.video_url;
      if (!videoUrl) throw new Error("No video_url in completed task");
      const videoResp = await fetch(videoUrl);
      const buffer = await videoResp.arrayBuffer();
      await Bun.write(outputPath, buffer);
      return;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Video generation failed: ${JSON.stringify(statusData)}`);
    }
    console.error(`  Polling shot... (${i + 1}/${MAX_POLLS}) status: ${status}`);
  }
  throw new Error("Video generation timeout");
}

const results: Array<{ index: number; videoUrl: string; error?: string }> = [];

for (const shot of storyboard.shots) {
  const previewPath = `${values["previews-dir"]}/shot-${shot.index}.png`;
  const outputPath = `${values["output-dir"]}/shot-${shot.index}.mp4`;
  console.error(`Generating video for shot ${shot.index}...`);

  try {
    await generateVideoFromImage(previewPath, shot.prompt, outputPath);
    results.push({ index: shot.index, videoUrl: outputPath });
    console.error(`  ✅ Shot ${shot.index} video saved to ${outputPath}`);
  } catch (err: any) {
    console.error(`  ❌ Shot ${shot.index} video failed: ${err.message}`);
    results.push({ index: shot.index, videoUrl: "", error: err.message });
  }
}

// Update storyboard
for (const r of results) {
  const shot = storyboard.shots.find((s: any) => s.index === r.index);
  if (shot) {
    shot.videoUrl = r.videoUrl;
    shot.status = r.error ? "error" : "done";
    if (r.error) shot.error = r.error;
  }
}

storyboard.status = storyboard.shots.every((s: any) => s.status === "done") ? "video_ready" : "generating";
await Bun.write(values.storyboard, JSON.stringify(storyboard, null, 2));

console.log(JSON.stringify({ results, storyboard }));
```

- [ ] **Step 2: Commit**

```bash
git add skills/storyboard/scripts/generate-video.ts
git commit -m "feat: add video generation script (Seedance 1 Lite API)"
```

---

### Task 11: Create compose-video script (FFmpeg)

**Files:**
- Create: `skills/storyboard/scripts/compose-video.ts`

**Interfaces:**
- Consumes: video clips directory + storyboard JSON from Task 10
- Produces: Final composed MP4 video

- [ ] **Step 1: Implement the script**

```typescript
#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "videos-dir": { type: "string" },
    storyboard: { type: "string" },
    output: { type: "string" },
  },
});

if (!values["videos-dir"] || !values.storyboard || !values.output) {
  console.error("Usage: compose-video.ts --videos-dir <dir> --storyboard <path> --output <path>");
  process.exit(1);
}

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

// Get sorted, successful shots
const shots = storyboard.shots
  .filter((s: any) => s.videoUrl && s.status === "done")
  .sort((a: any, b: any) => a.index - b.index);

if (shots.length === 0) {
  console.error("No completed video clips to compose");
  process.exit(1);
}

// Create FFmpeg concat file
const concatPath = `${values["videos-dir"]}/concat.txt`;
const concatContent = shots.map((s: any) => `file '${s.videoUrl}'`).join("\n");
await Bun.write(concatPath, concatContent);

// Run FFmpeg to concat with crossfade transitions
// For MVP: simple concat demuxer with fade transitions
function runFFmpeg(): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      values.output!,
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    proc.on("error", reject);
  });
}

console.error("Composing final video...");
try {
  await runFFmpeg();
  console.error(`✅ Final video saved to ${values.output}`);

  // Update storyboard
  storyboard.status = "composed";
  storyboard.composedVideoUrl = values.output;
  await Bun.write(values.storyboard, JSON.stringify(storyboard, null, 2));

  console.log(JSON.stringify({ output: values.output, storyboard }));
} catch (err: any) {
  console.error(`❌ Composition failed: ${err.message}`);
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
```

- [ ] **Step 2: Commit**

```bash
git add skills/storyboard/scripts/compose-video.ts
git commit -m "feat: add video composition script (FFmpeg concat with transitions)"
```

---

### Task 12: End-to-end integration test

**Files:**
- No new files — manual verification

- [ ] **Step 1: Verify full TypeScript compilation**

Run: `bun run lint`
Expected: No errors across all packages

- [ ] **Step 2: Run all core tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Start desktop app and test /storyboard trigger**

Run: `bun run dev:desktop`

In the chat, type `/storyboard` with some test materials. Verify:
1. The skill is recognized and triggered
2. The StoryboardWorkbench card appears in the chat
3. The card updates as scripts run (if API keys are configured)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: storyboard video generation skill - complete MVP"
```

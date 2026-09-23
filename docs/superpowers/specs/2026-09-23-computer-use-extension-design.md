# Customer Agent Computer Use Extension Design

## Goal

Add a default `computer` model tool to Customer Agent on macOS without coupling desktop automation to `AgentLoop` or exposing it to the native Codex, Claude Code, or OpenCode runtimes.

The tool observes the frontmost macOS application through Accessibility first, performs one semantic action at a time, and uses a screenshot only when the Accessibility representation is unavailable or insufficient. Customer Agent invokes it directly without a CA approval dialog. macOS Screen Recording and Accessibility permissions remain authoritative.

## Scope

The first release:

- supports macOS only;
- registers one `computer` tool only for `customer-agent` runs;
- leaves Codex, Claude Code, and OpenCode unchanged because they own their native Computer Use implementations;
- prioritizes the frontmost application's focused Accessibility window and focused element;
- falls back to a JPEG screenshot for inaccessible, empty, or semantically incomplete interfaces;
- supports observe, press, click, double-click, type, keypress, scroll, move, drag, wait, and explicit screenshot actions;
- executes exactly one action per tool call and returns a fresh observation afterward;
- never persists raw Accessibility trees or screenshots as durable session history.

Windows support, an MCP facade for native runtimes, OCR, long-lived visual history, and multi-action macros are outside this release.

## Current Runtime Boundary

Customer Agent follows this path:

```text
Desktop renderer
  -> local Server HTTP/SSE
  -> Server AgentHost composition root
  -> AgentBuilder
  -> AgentLoop
      -> ModelProvider
      -> ToolRegistry / ToolExecutor
      -> ITool extension
```

Codex, Claude Code, and OpenCode take a separate path through `NativeRuntimeService`, the native runtime broker, `UnifiedSessionService`, and their own adapters. They do not use Customer Agent's `ToolRegistry`. The Computer Use extension must therefore be registered only in the Customer Agent composition root.

## Dependency Direction

Create a new workspace package named `@agent/computer-use`:

```text
@agent/server ------> @agent/computer-use ------> @agent/core
                              ^
Electron desktop ------------|

@agent/core must not depend on @agent/computer-use.
```

`@agent/computer-use` owns platform-neutral domain rules, application use cases, the Customer Agent tool adapter, and the relay protocol/client. Electron owns concrete macOS and screen-capture adapters because the server package must not import Electron or AppKit.

The package layout is:

```text
packages/computer-use/src/
  domain/
    computer-action.ts
    computer-observation.ts
    accessibility-node.ts
    observation-policy.ts
  application/
    observe-computer.ts
    execute-computer-action.ts
  ports/
    computer-runtime-port.ts
  interface/
    computer-tool.ts
  infrastructure/
    relay-client.ts
    relay-protocol.ts

packages/desktop/main/computer-use/
  mac-accessibility-adapter.ts
  electron-screen-capture-adapter.ts
  desktop-input-adapter.ts
  desktop-computer-runtime.ts
  computer-relay-server.ts
```

The server registers the extension through the existing tool extension point. `AgentLoop` never imports macOS, Accessibility, Electron, screenshots, or the relay protocol.

## Domain Model

### Actions

The tool accepts one flat action object per call. A flat schema is intentionally easier for OpenAI-compatible APIs and AIHub webpage models to generate than a deeply nested union.

```ts
type ComputerAction =
  | { action: "observe" }
  | { action: "press"; revision: string; nodeId: string }
  | { action: "click" | "double_click"; revision?: string; nodeId?: string; x?: number; y?: number; button?: "left" | "right" | "middle" }
  | { action: "type"; revision: string; nodeId: string; text: string; replace?: boolean }
  | { action: "keypress"; keys: string[] }
  | { action: "scroll"; revision?: string; nodeId?: string; x?: number; y?: number; deltaX?: number; deltaY: number }
  | { action: "move"; x: number; y: number }
  | { action: "drag"; startX: number; startY: number; endX: number; endY: number; durationMs?: number }
  | { action: "wait"; durationMs: number }
  | { action: "screenshot" };
```

Node-based actions are preferred. Coordinates are valid only against the most recent screenshot and use screenshot pixels, not Retina backing scale or global display coordinates.

### Accessibility Observation

The macOS adapter resolves `NSWorkspace.shared.frontmostApplication`, creates an application AX root with `AXUIElementCreateApplication(pid)`, and selects the focused window. A focused sheet, dialog, menu, or popover takes precedence over the ordinary window. Dock, menu-bar, login, and other system UI may use the system-wide AX root.

The observation is a bounded flat node list with parent references:

```ts
interface AccessibilityObservation {
  source: "accessibility";
  revision: string;
  coverage: "complete" | "partial";
  app: { name: string; bundleId: string; pid: number };
  window?: { title?: string; bounds?: Bounds };
  nodes: AccessibilityNode[];
}

interface AccessibilityNode {
  id: string;
  parentId?: string;
  role: string;
  subrole?: string;
  name?: string;
  value?: string;
  description?: string;
  identifier?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  bounds?: Bounds;
  actions: string[];
}
```

Node IDs are ephemeral and include the snapshot revision. The Swift helper maintains the current revision's `AXUIElement` registry. Any newer observation invalidates the previous registry. A stale node action fails with `stale_observation`; it never falls through to a guessed coordinate.

Secure text values are never serialized. Traversal is bounded to 500 nodes, depth 20, 40,000 aggregate text characters, and 1.5 seconds. Attributes are allowlisted. Unsupported CF values, cycles, destroyed elements, and per-attribute AX errors are skipped without failing the entire snapshot.

### Observation Selection

`ObservationSelectionPolicy` is pure domain logic. It returns Accessibility when the snapshot has a frontmost target and meaningful text or actionable nodes. It marks coverage partial for empty web areas, canvas-like surfaces, large unrepresented content regions, or truncated traversal. It chooses a screenshot automatically only when Accessibility is denied, times out, has no usable root, or has no meaningful nodes.

A partial AX result is returned without an automatic screenshot. The tool description instructs the model to request `screenshot` only when the target cannot be resolved from the partial tree. This preserves the AX-first invariant while supporting Canvas and other hybrid applications.

## Application Flow

`ExecuteComputerActionUseCase` serializes every action through one runtime-wide queue:

```text
validate action
  -> verify desktop ownership and permissions
  -> verify revision/node when required
  -> execute one semantic or coordinate action
  -> wait for a short UI settle interval
  -> observe again through ObserveComputerUseCase
  -> return the new observation
```

Semantic behavior:

- `press` invokes AX Press when exposed.
- `click` and `double_click` invoke AX Press when the node supports it; otherwise they click the node center through the existing CGEvent helper.
- `type` focuses the AX text control, optionally sends Command+A, and injects text through the existing helper so application keyboard behavior remains intact.
- `scroll` places the pointer at the node center before sending wheel events; coordinate scroll uses screenshot coordinates.
- `move` and `drag` are visual-coordinate operations.
- every mutating action returns a new observation;
- `wait` is cancellable and also returns a new observation.

Only one action may own the global desktop queue at a time, including actions from different Customer Agent sessions.

## macOS Infrastructure

Extend the existing persistent Swift `desktop-input` helper rather than creating another privileged process. Add protocol operations for:

- Accessibility snapshot;
- AX node action;
- AX focus;
- current revision validation;
- existing mouse, wheel, key, and text injection.

Keep current remote-control operations backward compatible. Existing JSON-lines request IDs, timeouts, and click hit-test responses remain valid.

Extract the reusable single-frame capture operation from `DesktopScreenScreencast`. Remote desktop streaming keeps its current adaptive loop; Computer Use calls the same capture implementation for one frame. Coordinate conversion maps returned JPEG pixels to the selected display's logical coordinates and global origin.

The Electron main process hosts a dedicated line-delimited JSON Unix socket. It follows the existing AIHub relay pattern:

- directory mode `0700`;
- socket mode `0600`;
- bounded request and response sizes;
- request IDs and one response per request;
- stale socket cleanup only after the Electron single-instance lock is owned;
- normal shutdown closes and removes the socket.

The relay exposes no arbitrary command execution and accepts only the Computer Use protocol.

## Generic Tool Attachments

Screenshot fallback requires a model-visible image without adding computer-specific behavior to `AgentLoop`. Extend the generic tool result contract with ephemeral model attachments:

```ts
interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  modelAttachments?: Array<{
    type: "image";
    mimeType: "image/jpeg" | "image/png";
    dataUrl: string;
  }>;
}
```

After all tool results for an assistant turn have been added, `AgentLoop` creates one transient tool-observation message containing the attachments and their call IDs. Providers adapt that generic message:

- OpenAI sends a user image-content observation after all required tool messages;
- Anthropic sends image content blocks in the observation;
- AIHub uploads the latest tool-observation images with the follow-up transcript;
- providers without image input continue to use AX text observations, but screenshot fallback returns `vision_unavailable` rather than pretending that the model saw an image.

Attachment payloads are not included in public `tool_result` events, SQLite messages, logs, diagnostics, compaction checkpoints, or later user turns. Public events may expose only attachment count, MIME type, and dimensions.

This attachment support is generic and may be reused by other tools. No provider adapter contains Computer Use conditionals.

## Registration And Authorization

The Server Customer Agent composition root creates a `ComputerRelayClient`, wraps it in `ComputerTool`, and registers it with `AgentBuilder.withTool`. The native runtime broker and its Codex, Claude Code, and OpenCode adapters are untouched.

The extension declares a generic tool authorization policy of direct execution. It does not enter the CA approval queue, including when a session otherwise uses request-approval mode. This is an explicit product decision for this local capability. macOS Accessibility and Screen Recording permissions remain mandatory and cannot be bypassed.

The tool is visible only when the Server can reach a compatible desktop relay during run setup. If the desktop exits after registration, execution returns `desktop_offline`.

## Ownership And Concurrency

Observation is allowed while a phone remote viewer controls the desktop. Mutating actions are rejected while the live-view state is `handoff-requested`, `user-controlled`, `return-requested`, or `resyncing`, with `desktop_controlled_by_user`.

The Electron runtime owns the global action queue and the authoritative ownership check. Server-side serialization is insufficient because multiple Server processes may connect to the same desktop relay.

Cancellation closes or marks the in-flight request and prevents follow-up observation. A single CGEvent already posted before cancellation is reported as possibly executed; the system never labels it unexecuted. `wait` checks cancellation during the delay.

## Limits And Errors

Limits:

- normal relay request timeout: 8 seconds;
- AX snapshot timeout: 1.5 seconds;
- maximum wait: 5 seconds;
- maximum input text: 10,000 characters;
- maximum screenshot payload: 4 MiB after encoding;
- maximum request line: 128 KiB;
- maximum response line: 6 MiB.

Structured error codes:

- `desktop_offline`;
- `accessibility_denied`;
- `screen_recording_denied`;
- `desktop_controlled_by_user`;
- `stale_observation`;
- `node_not_found`;
- `action_not_supported`;
- `observation_timeout`;
- `action_timeout`;
- `vision_unavailable`;
- `aborted`.

Errors are returned as failed tool results with a concise recovery instruction. The model must re-observe after stale state, request a screenshot only after a partial AX result, or tell the user which macOS permission is missing.

## Verification

### Domain And Application Tests

- action schema accepts every supported action and rejects ambiguous node/coordinate combinations;
- observation selection prefers meaningful AX trees and falls back only under the documented conditions;
- secure values are redacted;
- traversal and text bounds are enforced;
- revisions invalidate old nodes;
- the application use case serializes concurrent sessions;
- cancellation stops wait and follow-up observation;
- phone ownership permits observation and rejects mutation.

### Relay And Adapter Tests

- relay rejects malformed, oversized, and unsupported requests;
- socket permissions and stale-socket cleanup follow the local relay contract;
- relay client reports offline, timeout, and structured server errors;
- existing DesktopInputGateway operations remain compatible;
- coordinate conversion covers Retina scale, non-primary display origins, and screenshot downscaling;
- one-frame capture returns nonempty bounded JPEG data;
- desktop shutdown releases helper, queue, socket, and node registry resources.

### Agent Integration Tests

- Customer Agent exposes `computer`; native Codex, Claude Code, and OpenCode paths do not change;
- direct execution emits no CA approval request;
- AX results return through ordinary textual tool results;
- screenshot results reach OpenAI, Anthropic, and AIHub as transient images;
- a provider without vision receives `vision_unavailable` on visual fallback;
- public events and persisted session/checkpoint rows do not contain screenshot Base64 data.

### macOS Runtime Acceptance

Use a deterministic foreground fixture with a text field, button, status label, scroll region, and Canvas-only target:

1. `observe` returns the fixture's AX nodes without a screenshot.
2. `type` targets the text-field node and the refreshed AX observation contains the new value.
3. `press` targets the button node and the refreshed status node changes.
4. the Canvas target produces partial or unusable AX coverage and then a nonblank screenshot fallback.
5. a coordinate click against the screenshot changes the Canvas fixture state.
6. stale node revisions are rejected.
7. disabling Accessibility produces `accessibility_denied` for mutation without a CA approval dialog.
8. disabling Screen Recording affects only screenshot fallback.
9. phone takeover blocks mutation and returning control restores it.
10. a real Customer Agent turn reaches the relay, executes at least one semantic AX action, receives the refreshed observation, and completes based on the tool result.

Automated tests and builds are necessary but do not replace the final real macOS AgentLoop-to-Electron acceptance.

## Compatibility

Existing file, shell, network, MCP, Skill, AIHub, remote desktop, and native runtime behavior must remain unchanged. The Swift helper protocol additions are backward compatible. The new package is private and is built before Server and Desktop consumers. Removing its composition-root registration removes the feature without modifying `AgentLoop` behavior beyond the generic attachment and authorization extension points.

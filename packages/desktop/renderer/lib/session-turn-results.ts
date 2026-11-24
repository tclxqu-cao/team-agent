import { fileChangeLineStats, fileChangeOperation, type FileChangeOperation, type FileLineStats } from "../../../core/src/domain/tool/file-change-summary";
import type { ChatMessage } from "../stores/agentStore";
import type { SessionToolResultBody, SessionToolResultRef } from "@agent/core";
import { resolveWebArtifactPath } from "../../../shared/src/browser/artifact-links";
import { codexExecutionSegmentMessages, mergeCodexExecutionMessages } from "./codex-execution-trace";
import { editLineStats, multiEditLineStats, patchChanges, patchSummary, textPatchChanges } from "./file-tool-presentation";
import { normalizeMessageLinks, parseRichInlineTokens } from "./markdown-links";
import { parseStructuredAgentMessage } from "./structured-agent-message";
import type { SessionExecutionMessage } from "./session-execution-trace";
import { canonicalToolName } from "./tool-call-presentation";
import { hasToolCallResult } from "./tool-call-status";

type ToolCall = NonNullable<ChatMessage["toolCalls"]>[number];
type Trace = NonNullable<ChatMessage["executionTrace"]>;

export interface TurnFileChange {
  path: string;
  operation: FileChangeOperation;
  stats: FileLineStats | null;
  tool: ToolCall;
  recordedPath?: string;
  patch?: string;
  before?: string;
}

export interface SessionTurnResult {
  sourceId?: string;
  footerId: string;
  messages: ChatMessage[];
  traces: Trace[];
}

/** Use the same boundaries as the transcript and keep steered inputs in their original run. */
export function sessionTurnResults(messages: readonly SessionExecutionMessage[], running: boolean): SessionTurnResult[] {
  const results: SessionTurnResult[] = [];
  let source: ChatMessage | undefined;
  let turn: SessionExecutionMessage[] = [];
  const finish = (active: boolean) => {
    const last = turn.findLast(message => message.role === "assistant" && !message.askUser && !message.widget);
    const question = turn.at(-1)?.askUser;
    if (!last || (question && !question.answered && !question.cancelled)) return;
    if (active && last.presentation?.agentMessagePhase !== "final_answer" && !last.presentation?.runResult) return;
    const traces = turn.flatMap(message => message.executionTrace ? [message.executionTrace] : []);
    results.push({
      sourceId: source?.id,
      footerId: last.id,
      messages: turn.flatMap(message => message.executionGroup?.messages ?? [message]),
      traces,
    });
  };

  for (const message of messages) {
    if (message.isQueued || message.isCompactionSummary) continue;
    if (message.name === "__thread_switch__") {
      finish(false);
      source = undefined;
      turn = [];
      continue;
    }
    if (message.role === "user" && !message.isSteered) {
      const owner = source?.presentation?.executionTrace?.turnId;
      if (owner && owner === message.presentation?.executionTrace?.turnId) continue;
      finish(false);
      source = message;
      turn = [];
    } else {
      turn.push(message);
    }
  }
  finish(running);
  return results;
}

export function traceNeedsTurnResults(trace: Trace): boolean {
  return !trace.revision.startsWith("live:") && (trace.historyItemKeys === undefined
    || trace.historyItemKeys.some(key => key.startsWith("tool:")));
}

export function turnResultMessages(turn: SessionTurnResult, history: ReadonlyMap<string, ChatMessage[]>): ChatMessage[] {
  return turn.messages.flatMap(message => {
    const trace = message.executionTrace;
    if (!trace) return [message];
    const native = history.get(trace.turnId);
    const live = trace.liveMessages ?? [];
    if (!native) return trace.segmentIndex && trace.historyItemKeys === undefined && !trace.revision.startsWith("live:") ? [] : live;
    return mergeCodexExecutionMessages(codexExecutionSegmentMessages(native, trace.segmentIndex ?? 0), live);
  });
}

const WRITE_TOOLS = new Set(["Write", "write_file", "create_file"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "str_replace", "NotebookEdit", "edit_file", "replace_string_in_file", "insert_edit_into_file"]);

/** Restore omitted file identities only when the native summary proves the list was shortened. */
export async function restoreOmittedPatchFiles(messages: ChatMessage[], load: (ref: SessionToolResultRef) => Promise<SessionToolResultBody>): Promise<ChatMessage[]> {
  const restored: ChatMessage[] = [];
  for (const message of messages) {
    let tools: ToolCall[] | undefined;
    for (const [index, tool] of (message.toolCalls ?? []).entries()) {
      if (tool.name !== "apply_patch" || !tool.resultRef || tool.result !== undefined || tool.isError || tool.resultRef.isError) continue;
      const count = patchSummary(tool.arguments)?.fileCount ?? 0;
      if (patchChanges(tool.arguments).length >= count) continue;
      const body = await load(tool.resultRef);
      const entries = patchChanges({}, body.content);
      if (entries.length < count) throw new Error("补丁的文件记录不完整，请重试");
      tools ??= [...message.toolCalls!];
      tools[index] = { ...tool, arguments: { ...tool.arguments, changes: entries }, isError: body.isError };
    }
    restored.push(tools ? { ...message, toolCalls: tools } : message);
  }
  return restored;
}

export function collectTurnChanges(messages: readonly ChatMessage[], workspacePath?: string | null): TurnFileChange[] {
  const changes: TurnFileChange[] = [];
  const beforeByPath = new Map<string, string>();
  for (const tool of uniqueTurnTools(messages)) {
    if (tool.isError || tool.resultRef?.isError || !hasToolCallResult(tool)) continue;
    const name = canonicalToolName(tool.name);
    const args = tool.arguments;
    const cwd = typeof args.cwd === "string" ? resolveWebArtifactPath(args.cwd, workspacePath) ?? workspacePath : workspacePath;
    if (name === "apply_patch" || name === "patch") {
      const recorded = patchChanges(args, tool.result);
      const patch = args.patch ?? args.patchText ?? args.input;
      const parsed = recorded.length ? recorded : typeof patch === "string" ? textPatchChanges(patch) : [];
      const applied = tool.result?.match(/^Applied patch to:\r?\n([\s\S]*?)(?:\r?\n\r?\nErrors:|$)/)?.[1];
      const appliedPaths = applied === undefined ? null : new Set(applied.split(/\r?\n/).map(line => line.replace(/ \(\d+ hunks?\)$/, "")));
      for (const change of parsed) {
        const operation = fileChangeOperation(change);
        const path = typeof change.path === "string" ? resolveWebArtifactPath(change.path, cwd) : null;
        if (!path || !operation || (appliedPaths && !appliedPaths.has(path))) continue;
        changes.push({ path, operation, stats: fileChangeLineStats(recorded.length ? change : { ...change, kind: "update" }), tool,
          recordedPath: typeof change.path === "string" ? change.path : undefined,
          patch: typeof change.diff === "string" ? change.diff : undefined });
        beforeByPath.delete(path);
      }
      continue;
    }
    const rawPath = args.file_path ?? args.filePath ?? args.filepath ?? args.path ?? args.notebook_path;
    const path = typeof rawPath === "string" ? resolveWebArtifactPath(rawPath, cwd) : null;
    if (!path) continue;
    if ((name === "Read" || name === "read_file") && typeof tool.result === "string"
      && ![args.offset, args.limit, args.startLine, args.endLine].some(value => value !== undefined)) {
      beforeByPath.set(path, tool.result);
    } else if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
      const writing = WRITE_TOOLS.has(name);
      const edit = { ...args, file_path: rawPath, old_string: args.old_string ?? args.oldString ?? args.old_str,
        new_string: args.new_string ?? args.newString ?? args.new_str };
      const textEdit = typeof edit.old_string === "string" && typeof edit.new_string === "string";
      const displayTool = writing ? { ...tool, name: "write_file", arguments: { ...args, file_path: rawPath, content: args.content ?? args.file_text ?? args.text } }
        : textEdit ? { ...tool, name: "str_replace", arguments: edit } : tool;
      changes.push({ path, operation: name === "create_file" ? "add" : "update", tool: displayTool,
        stats: writing ? null : name === "MultiEdit" ? multiEditLineStats(args) : editLineStats(edit),
        before: writing ? beforeByPath.get(path) : undefined });
      beforeByPath.delete(path);
    }
  }
  return changes;
}

function uniqueTurnTools(messages: readonly ChatMessage[]): ToolCall[] {
  const tools = new Map<string, ToolCall>();
  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      const previous = tools.get(tool.id);
      if (previous && !hasToolCallResult(tool) && hasToolCallResult(previous)) continue;
      tools.set(tool.id, tool);
    }
  }
  return [...tools.values()];
}

export function collectTurnArtifacts(messages: readonly ChatMessage[], changes: readonly TurnFileChange[], workspacePath?: string | null) {
  const changedPaths = new Set(changes.map(change => change.path));
  const artifacts = new Map<string, { path: string; label: string }>();
  for (const message of messages) {
    if (message.role !== "assistant" || message.askUser || message.widget
      || message.presentation?.agentMessagePhase === "commentary" || !message.content.trim()) continue;
    const structured = parseStructuredAgentMessage(message.content);
    const body = structured?.kind === "envelope"
      ? structured.value.blocks.flatMap(block => block.kind === "text" ? [block.text] : []).join("\n")
      : message.content;
    const prose = normalizeMessageLinks(body).split(/^[ \t]*```.*$/m).filter((_, index) => index % 2 === 0).join("\n");
    for (const token of parseRichInlineTokens(prose)) {
      if (token.type !== "artifact" || token.line !== undefined) continue;
      const path = resolveWebArtifactPath(token.path, workspacePath);
      const namedLink = token.raw.startsWith("[") && token.label !== token.path;
      if (path && (namedLink || !changedPaths.has(path))) artifacts.set(path, { path, label: token.label === token.path ? turnFileName(path) : token.label });
    }
  }
  return [...artifacts.values()];
}

export function turnFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function groupTurnChanges(changes: readonly TurnFileChange[]): Map<string, TurnFileChange[]> {
  const files = new Map<string, TurnFileChange[]>();
  for (const change of changes) {
    const previous = files.get(change.path);
    if (previous) previous.push(change);
    else files.set(change.path, [change]);
  }
  return files;
}

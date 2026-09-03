import { useState, useMemo, useEffect } from "react";
import type { NativeSubagentActivity, RuntimeProgress } from "@agent/core";
import {
  Check,
  ChevronRight,
  CircleX,
  FileText,
  ListTodo,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wrench,
} from "lucide-react";
import { useAgentStore } from "../stores/agentStore";
import { hasToolCallResult } from "../lib/tool-call-status";
import { toolActivityLabel, toolFamily, toolPhrase, toolPreview } from "../lib/tool-call-presentation";
import RuntimeProgressRow from "./RuntimeProgressRow";

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

interface ToolCallProps {
  toolCall: ToolCallData;
  progress?: RuntimeProgress;
  nativeSubagent?: NativeSubagentActivity;
  onSelectSession?: (sessionId: string) => void;
  /** For write_file: content BEFORE the write (from a preceding read_file) — enables diff view */
  beforeContent?: string;
}

// ── Status icon: spinner / checkmark / x-circle ──────────────────────────
function StatusIcon({ isDone, isError, color, size = 11 }: { isDone: boolean; isError?: boolean; color: string; size?: number }) {
  if (!isDone) {
    return <LoaderCircle size={size} color={color} strokeWidth={2.5} style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} aria-hidden="true" />;
  }
  if (isError) {
    return <CircleX size={size} color={color} strokeWidth={2.5} aria-hidden="true" />;
  }
  return <Check size={size} color={color} strokeWidth={2.5} aria-hidden="true" />;
}

function ToolActionIcon({ name, color, size = 14 }: { name: string; color: string; size?: number }) {
  const family = toolFamily(name);
  if (family === "command") {
    return <SquareTerminal size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (family === "search") {
    return <Search size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (family === "file") {
    return name === "Read" || name === "read_file"
      ? <FileText size={size} color={color} strokeWidth={1.8} aria-hidden="true" />
      : <Pencil size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "Skill") return <Sparkles size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
  if (name === "TodoWrite") return <ListTodo size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
  if (name === "Task" || name === "dispatch_agent" || name === "Agent") {
    return <UserRound size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
  }
  return <Wrench size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
}

// ── Shared card shell: left gutter bar + header button + expandable body ──
interface CardShellProps {
  statusColor: string;
  isDone: boolean;
  expanded: boolean;
  onToggle: () => void;
  header: React.ReactNode;
  children: React.ReactNode;
  maxBodyHeight?: number;
}
function CardShell({ statusColor, isDone, expanded, onToggle, header, children, maxBodyHeight = 600 }: CardShellProps) {
  return (
    <div className="tool-call-shell" style={{ marginTop: 4, borderRadius: 9, border: "1px solid var(--border-subtle)", overflow: "hidden", background: "var(--bg-deepest)", fontSize: 12, minWidth: 0 }}>
      <div className="tool-call-shell__row" style={{ display: "flex", alignItems: "stretch" }}>
        {/* Left status gutter */}
        <div className="tool-call-shell__status" style={{
          width: 3, flexShrink: 0,
          background: statusColor,
          animation: !isDone ? "statusBarPulse 1.8s ease-in-out infinite" : "none",
          borderRadius: "9px 0 0 0",
        }} />
        {/* Header */}
        <button
          type="button"
          className="tool-call-shell__header"
          aria-expanded={expanded}
          onClick={onToggle}
          style={{ flex: 1, border: "none", background: "var(--bg-deep)", cursor: "pointer", padding: "7px 10px 7px 9px", display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--font-body)", transition: "background 0.12s", textAlign: "left", minWidth: 0 }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-elevated)")}
          onMouseLeave={e => (e.currentTarget.style.background = "var(--bg-deep)")}
        >
          {header}
          {/* Chevron */}
          <ChevronRight className="tool-call-shell__chevron" size={12} color="var(--text-muted)" strokeWidth={2.2} style={{ transition: "transform 0.25s var(--ease-out)", transform: expanded ? "rotate(90deg)" : "rotate(0deg)", flexShrink: 0 }} aria-hidden="true" />
        </button>
      </div>
      {/* Collapsed bodies stay unmounted so large historical tool output is parsed on demand. */}
      {expanded && (
        <div className="tool-call-shell__body" style={{ overflow: "hidden", maxHeight: maxBodyHeight, opacity: 1, transition: "max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease" }}>
          <div className="tool-call-shell__body-content" style={{ borderTop: "1px solid var(--border-subtle)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, boxSizing: "border-box", maxWidth: "100%" }}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tag pills ─────────────────────────────────────────────────────────────
function Tag({ label, color = "var(--text-muted)", bg = "var(--bg-surface)" }: { label: string; color?: string; bg?: string }) {
  return (
    <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 20, background: bg, color, fontWeight: 500, flexShrink: 0, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function lineCount(s: string): number {
  return s ? s.split("\n").length : 0;
}

type DiffLine = { type: "added" | "removed" | "same"; text: string; lineNo: number };

function computeDiff(before: string, after: string): DiffLine[] {
  const bl = before.split("\n");
  const al = after.split("\n");
  if (bl.length * al.length > 200_000) {
    return al.map((text, i) => ({ type: "added" as const, text, lineNo: i + 1 }));
  }
  const m = bl.length, n = al.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = bl[i-1] === al[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  const lcs: Array<[number,number]> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (bl[i-1] === al[j-1]) { lcs.unshift([i-1, j-1]); i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  const result: DiffLine[] = [];
  let bi = 0, ai = 0;
  for (const [bIdx, aIdx] of lcs) {
    while (bi < bIdx) { result.push({ type: "removed", text: bl[bi], lineNo: bi+1 }); bi++; }
    while (ai < aIdx) { result.push({ type: "added", text: al[ai], lineNo: ai+1 }); ai++; }
    result.push({ type: "same", text: bl[bi], lineNo: bi+1 });
    bi++; ai++;
  }
  while (bi < m) { result.push({ type: "removed", text: bl[bi], lineNo: bi+1 }); bi++; }
  while (ai < n) { result.push({ type: "added", text: al[ai], lineNo: ai+1 }); ai++; }
  return result;
}

function CodeBlock({ content, maxHeight = 320 }: { content: string; maxHeight?: number }) {
  const lines = content.split("\n");
  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border-subtle)", borderRadius:8, overflow:"auto", maxHeight, fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.65 }}>
      <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
        <colgroup><col style={{ width:40 }}/><col/></colgroup>
        <tbody>
          {lines.map((line, idx) => (
            <tr key={idx}>
              <td style={{ padding:"0 8px", color:"var(--text-muted)", textAlign:"right", userSelect:"none", borderRight:"1px solid var(--border-subtle)", background:"var(--bg-deep)", fontSize:10, minWidth:36 }}>{idx+1}</td>
              <td style={{ padding:"0 12px", color:"var(--text-secondary)", wordBreak:"break-all", whiteSpace:"pre-wrap" }}>{line||" "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffBlock({ diff, maxHeight = 360 }: { diff: DiffLine[]; maxHeight?: number }) {
  const changed = diff.filter(d => d.type !== "same");
  if (changed.length === 0) return <div style={{ fontSize:11, color:"var(--text-muted)", padding:"10px 12px", fontFamily:"var(--font-mono)" }}>内容未变化</div>;
  const changedIdxs = new Set(diff.map((d,i) => d.type!=="same"?i:-1).filter(i=>i>=0));
  const visible = new Set<number>();
  changedIdxs.forEach(ci => { for (let k=Math.max(0,ci-3);k<=Math.min(diff.length-1,ci+3);k++) visible.add(k); });
  const rows: Array<{diffLine:DiffLine;diffIdx:number}|"ellipsis"> = [];
  let last = -1;
  [...visible].sort((a,b)=>a-b).forEach(idx => {
    if (last>=0 && idx>last+1) rows.push("ellipsis");
    rows.push({diffLine:diff[idx],diffIdx:idx});
    last=idx;
  });
  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border-subtle)", borderRadius:8, overflow:"auto", maxHeight, fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.65 }}>
      <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
        <colgroup><col style={{ width:24 }}/><col style={{ width:36 }}/><col/></colgroup>
        <tbody>
          {rows.map((row,i) => {
            if (row==="ellipsis") return <tr key={`e${i}`}><td colSpan={3} style={{ padding:"2px 12px", color:"var(--text-muted)", fontSize:10, background:"var(--bg-deep)", textAlign:"center" }}>⋯</td></tr>;
            const {diffLine} = row;
            const bg = diffLine.type==="added"?"rgba(5,150,105,0.08)":diffLine.type==="removed"?"rgba(220,38,38,0.07)":"transparent";
            const prefix = diffLine.type==="added"?"+":diffLine.type==="removed"?"−":" ";
            const prefixColor = diffLine.type==="added"?"var(--success)":diffLine.type==="removed"?"var(--danger)":"transparent";
            const textColor = diffLine.type==="added"?"#059669":diffLine.type==="removed"?"var(--danger)":"var(--text-secondary)";
            return (
              <tr key={i} style={{ background:bg }}>
                <td style={{ padding:"0 4px", textAlign:"center", color:prefixColor, fontWeight:700, userSelect:"none" }}>{prefix}</td>
                <td style={{ padding:"0 6px", color:"var(--text-muted)", textAlign:"right", fontSize:10, borderRight:"1px solid var(--border-subtle)", userSelect:"none" }}>{diffLine.lineNo}</td>
                <td style={{ padding:"0 12px", color:textColor, wordBreak:"break-all", whiteSpace:"pre-wrap" }}>{diffLine.text||" "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WriteFileCard({ toolCall, beforeContent }: { toolCall: ToolCallData; beforeContent?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"content"|"diff">("content");
  const filePath = (toolCall.arguments.file_path as string)??"";
  const content = (toolCall.arguments.content as string)??"";
  const lines = lineCount(content);
  const isError = toolCall.isError;
  const isDone = hasToolCallResult(toolCall);
  const statusColor = isDone ? (isError ? "var(--danger)" : "var(--success)") : "var(--accent)";
  const diff = useMemo(() => beforeContent && content ? computeDiff(beforeContent, content) : null, [beforeContent, content]);
  const diffStats = useMemo(() => {
    if (!diff) return null;
    return { added: diff.filter(d => d.type === "added").length, removed: diff.filter(d => d.type === "removed").length };
  }, [diff]);
  const iconColor = isError ? "var(--danger)" : isDone ? "var(--text-muted)" : "var(--accent)";

  const header = (
    <>
      <span className="tool-call-shell__icon">
        <ToolActionIcon name={toolCall.name} color={iconColor} />
      </span>
      <span className="tool-call-shell__label">写入</span>
      <span className="tool-call-shell__preview" style={{ flex: 1 }} title={filePath}>
        {basename(filePath)}
      </span>
      {/* Meta */}
      <Tag label={`${lines} 行`} color="var(--accent)" bg="var(--accent-dim)" />
      {diffStats && (
        <span style={{ display: "flex", gap: 3, fontSize: 10, flexShrink: 0 }}>
          {diffStats.added > 0 && <span style={{ color: "var(--success)" }}>+{diffStats.added}</span>}
          {diffStats.removed > 0 && <span style={{ color: "var(--danger)" }}>−{diffStats.removed}</span>}
        </span>
      )}
      {(!isDone || isError) && (
        <span className="tool-call-shell__state" style={{ color: statusColor }}>
          <StatusIcon isDone={isDone} isError={isError} color={statusColor} />
          {isError && <span>错误</span>}
        </span>
      )}
    </>
  );

  return (
    <CardShell statusColor={statusColor} isDone={isDone} expanded={expanded} onToggle={() => setExpanded(!expanded)} header={header}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{filePath}</div>
      {diff && (
        <div style={{ display: "flex", gap: 3 }}>
          {(["content", "diff"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "2px 9px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 500, background: tab === t ? "var(--accent-dim)" : "transparent", color: tab === t ? "var(--accent)" : "var(--text-muted)", transition: "background 0.12s" }}>
              {t === "content" ? "文件内容" : "变更行"}
            </button>
          ))}
        </div>
      )}
      {tab === "diff" && diff ? <DiffBlock diff={diff} /> : <CodeBlock content={content} />}
      {isError && toolCall.result && (
        <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)", padding: "8px 12px", background: "rgba(220,38,38,0.04)", border: "1px solid rgba(220,38,38,0.15)", borderLeft: "3px solid var(--danger)", borderRadius: 7 }}>{toolCall.result}</div>
      )}
    </CardShell>
  );
}

function ReadFileCard({ toolCall }: { toolCall: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = (toolCall.arguments.file_path as string)??"";
  const startLine = toolCall.arguments.startLine as number|undefined;
  const endLine = toolCall.arguments.endLine as number|undefined;
  const offset = toolCall.arguments.offset as number|undefined;
  const limit = toolCall.arguments.limit as number|undefined;
  const resultContent = toolCall.result??"";
  const lines = lineCount(resultContent);
  const isError = toolCall.isError;
  const isDone = hasToolCallResult(toolCall);
  const statusColor = isDone ? (isError ? "var(--danger)" : "var(--success)") : "var(--accent)";
  const rangeLabel = startLine !== undefined
    ? `L${startLine}–${endLine ?? "?"}`
    : offset !== undefined
      ? `第${offset}行起${limit ? ` ×${limit}` : ""}`
      : null;
  const iconColor = isError ? "var(--danger)" : isDone ? "var(--text-muted)" : "var(--accent)";

  const header = (
    <>
      <span className="tool-call-shell__icon">
        <ToolActionIcon name={toolCall.name} color={iconColor} />
      </span>
      <span className="tool-call-shell__label">查阅</span>
      <span className="tool-call-shell__preview" style={{ flex: 1 }} title={filePath}>
        {basename(filePath)}
      </span>
      {rangeLabel && <Tag label={rangeLabel} color="var(--accent)" bg="var(--accent-dim)" />}
      {isDone && !isError && <Tag label={`${lines} 行`} color="var(--text-muted)" bg="var(--bg-surface)" />}
      {(!isDone || isError) && (
        <span className="tool-call-shell__state" style={{ color: statusColor }}>
          <StatusIcon isDone={isDone} isError={isError} color={statusColor} />
          {isError && <span>错误</span>}
        </span>
      )}
    </>
  );

  return (
    <CardShell statusColor={statusColor} isDone={isDone} expanded={expanded} onToggle={() => setExpanded(!expanded)} header={header} maxBodyHeight={480}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{filePath}</div>
      {isDone && !isError
        ? <CodeBlock content={resultContent} />
        : isDone && isError && <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)", padding: "8px 12px", background: "rgba(220,38,38,0.04)", border: "1px solid rgba(220,38,38,0.15)", borderLeft: "3px solid var(--danger)", borderRadius: 7 }}>{resultContent}</div>
      }
    </CardShell>
  );
}

function StrReplaceCard({ toolCall }: { toolCall: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = (toolCall.arguments.file_path as string)??"";
  const oldString = (toolCall.arguments.old_string as string)??"";
  const newString = (toolCall.arguments.new_string as string)??"";
  const isError = toolCall.isError;
  const isDone = hasToolCallResult(toolCall);
  const statusColor = isDone ? (isError ? "var(--danger)" : "var(--success)") : "var(--accent)";
  const iconColor = isError ? "var(--danger)" : isDone ? "var(--text-muted)" : "var(--accent)";
  const diff = useMemo(() => oldString && newString ? computeDiff(oldString, newString) : null, [oldString, newString]);
  const diffStats = useMemo(() => diff ? { added: diff.filter(d => d.type === "added").length, removed: diff.filter(d => d.type === "removed").length } : null, [diff]);

  const header = (
    <>
      <span className="tool-call-shell__icon">
        <ToolActionIcon name={toolCall.name} color={iconColor} />
      </span>
      <span className="tool-call-shell__label">写入</span>
      <span className="tool-call-shell__preview" style={{ flex: 1 }} title={filePath}>
        {basename(filePath)}
      </span>
      {diffStats && (
        <span style={{ display: "flex", gap: 3, fontSize: 10, flexShrink: 0 }}>
          {diffStats.added > 0 && <span style={{ color: "var(--success)" }}>+{diffStats.added}</span>}
          {diffStats.removed > 0 && <span style={{ color: "var(--danger)" }}>−{diffStats.removed}</span>}
        </span>
      )}
      {(!isDone || isError) && (
        <span className="tool-call-shell__state" style={{ color: statusColor }}>
          <StatusIcon isDone={isDone} isError={isError} color={statusColor} />
          {isError && <span>错误</span>}
        </span>
      )}
    </>
  );

  return (
    <CardShell statusColor={statusColor} isDone={isDone} expanded={expanded} onToggle={() => setExpanded(!expanded)} header={header} maxBodyHeight={480}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{filePath}</div>
      {diff ? <DiffBlock diff={diff} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <pre style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)", padding: "8px 10px", borderRadius: 6, background: "rgba(220,38,38,0.04)", border: "1px solid rgba(220,38,38,0.12)", borderLeft: "3px solid var(--danger)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{oldString}</pre>
          <pre style={{ fontSize: 11, color: "var(--success)", fontFamily: "var(--font-mono)", padding: "8px 10px", borderRadius: 6, background: "rgba(5,150,105,0.04)", border: "1px solid rgba(5,150,105,0.12)", borderLeft: "3px solid var(--success)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{newString}</pre>
        </div>
      )}
      {isError && toolCall.result && (
        <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)", padding: "8px 10px", background: "rgba(220,38,38,0.04)", border: "1px solid rgba(220,38,38,0.15)", borderLeft: "3px solid var(--danger)", borderRadius: 7 }}>{toolCall.result}</div>
      )}
    </CardShell>
  );
}

function CollapsiblePre({ label, content, error, maxPreviewLines = 8, maxPreviewHeight = 200, maxExpandedHeight = 2000 }: { label: string; content: string; error?: boolean; maxPreviewLines?: number; maxPreviewHeight?: number; maxExpandedHeight?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > maxPreviewLines;
  const displayed = isLong && !expanded
    ? lines.slice(0, maxPreviewLines).join("\n") + "\n..."
    : content;
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>{label}</div>
      <pre style={{
        fontSize: 11, color: error ? "var(--danger)" : "var(--text-secondary)",
        whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "var(--font-mono)",
        padding: "9px 11px", borderRadius: 7, boxSizing: "border-box", maxWidth: "100%",
        background: error ? "rgba(220,38,38,0.04)" : "var(--bg-surface)",
        border: error
          ? "1px solid rgba(220,38,38,0.15)"
          : "1px solid var(--border-subtle)",
        borderLeft: error ? "3px solid var(--danger)" : "3px solid var(--success)",
        maxHeight: expanded ? maxExpandedHeight : maxPreviewHeight,
        overflow: "auto", margin: 0, lineHeight: 1.6,
      }}>
        {displayed}
      </pre>
      {isLong && (
        <button onClick={() => setExpanded(!expanded)} style={{ marginTop: 4, padding: "2px 10px", borderRadius: 5, border: "1px solid var(--border-subtle)", background: "var(--bg-deep)", color: "var(--text-muted)", fontSize: 10, cursor: "pointer", fontWeight: 500 }}>
          {expanded ? "收起" : `展开全部 (${lines.length} 行)`}
        </button>
      )}
    </div>
  );
}

function DispatchArgs({ arguments: args }: { arguments: Record<string, unknown> }) {
  const taskStr = (args.task as string) ?? "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 0" }}>
      <div style={{ display: "flex", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)", flexWrap: "wrap" }}>
        <Tag label={`agent: ${args.agentName as string}`} color="var(--accent)" bg="var(--accent-dim)" />
        <Tag label={`sid: ${(args.subSessionId as string)?.slice(0, 8)}…`} color="var(--text-muted)" bg="var(--bg-surface)" />
      </div>
      {taskStr && (
        <CollapsiblePre label="任务" content={taskStr} error={false} maxPreviewLines={3} maxPreviewHeight={80} maxExpandedHeight={2000} />
      )}
    </div>
  );
}

function ArgumentsBlock({ raw }: { raw: string }) {
  const [expanded, setExpanded] = useState(false);
  // Strip runtime-only ephemeral fields that are displayed separately
  let clean: string;
  try {
    const obj = JSON.parse(raw);
    delete obj.subAgentProgress;
    delete obj.subAgentStatus;
    delete obj.subAgentDetail;
    clean = JSON.stringify(obj, null, 2);
  } catch {
    clean = raw;
  }
  const LINES_THRESHOLD = 8;
  const lines = clean.split("\n");
  const isLong = lines.length > LINES_THRESHOLD;
  const displayed = isLong && !expanded
    ? lines.slice(0, LINES_THRESHOLD).join("\n") + "\n..."
    : clean;
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>参数</div>
      <pre style={{ fontSize: 11, color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "var(--font-mono)", padding: "9px 11px", borderRadius: 7, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", maxHeight: expanded ? 2000 : 200, overflow: "auto", margin: 0, lineHeight: 1.6, boxSizing: "border-box", maxWidth: "100%" }}>
        {displayed}
      </pre>
      {isLong && (
        <button onClick={() => setExpanded(!expanded)} style={{ marginTop: 4, padding: "2px 10px", borderRadius: 5, border: "1px solid var(--border-subtle)", background: "var(--bg-deep)", color: "var(--text-muted)", fontSize: 10, cursor: "pointer", fontWeight: 500 }}>
          {expanded ? "收起" : `展开全部 (${lines.length} 行)`}
        </button>
      )}
    </div>
  );
}

function NativeAgentActivity({ activity }: { activity: NativeSubagentActivity }) {
  const toolResults = new Map(activity.messages.flatMap((message) => (
    message.role === "tool" && message.toolCallId
      ? [[message.toolCallId, { content: message.content, isError: message.name === "error" }] as const]
      : []
  )));
  return (
    <div className="native-subagent-activity">
      <div className="native-subagent-activity__meta">
        {activity.elapsedSeconds !== undefined && <span>{activity.elapsedSeconds} 秒</span>}
        {activity.toolUses !== undefined && <span>{activity.toolUses} 次工具调用</span>}
        {activity.lastToolName && <span>正在使用 {activity.lastToolName}</span>}
      </div>
      {activity.messages.map((message, messageIndex) => (
        <div key={`${message.role}-${messageIndex}`} className="native-subagent-activity__entry">
          {message.role === "assistant" && message.content && (
            <pre className="native-subagent-activity__text">{message.content}</pre>
          )}
          {message.role === "assistant" && message.toolCalls?.map((toolCall) => {
            const result = toolResults.get(toolCall.id);
            return (
              <div key={toolCall.id} className="native-subagent-activity__tool">
                <ToolCallCard
                  toolCall={{
                    ...toolCall,
                    ...(result ? { result: result.content, isError: result.isError } : {}),
                  }}
                />
                {result && (
                  <pre className={`native-subagent-activity__tool-result${result.isError ? " native-subagent-activity__tool-result--error" : ""}`}>
                    {result.content}
                  </pre>
                )}
              </div>
            );
          })}
          {message.role === "tool" && message.toolCallId && !activity.messages.some(
            (candidate) => candidate.toolCalls?.some((toolCall) => toolCall.id === message.toolCallId),
          ) && (
            <CollapsiblePre label="工具结果" content={message.content} error={message.name === "error"} maxPreviewHeight={180} />
          )}
        </div>
      ))}
      {activity.summary && (
        <CollapsiblePre
          label={activity.status === "failed" ? "错误信息" : "执行摘要"}
          content={activity.summary}
          error={activity.status === "failed"}
          maxPreviewHeight={180}
        />
      )}
      {activity.status === "running" && activity.messages.length === 0 && !activity.summary && (
        <div className="native-subagent-activity__waiting">
          <StatusIcon isDone={false} color="var(--accent)" size={10} />
          子 agent 正在工作
        </div>
      )}
    </div>
  );
}

function GenericToolCard({ toolCall, onSelectSession, nativeSubagent }: { toolCall: ToolCallData; onSelectSession?: (id: string) => void; nativeSubagent?: NativeSubagentActivity }) {
  const runningSessionId = useAgentStore(s => s.runningSessionId);
  const [expanded, setExpanded] = useState(() => Boolean(nativeSubagent));
  const isDispatch = toolCall.name === "dispatch_agent";
  const isNativeAgent = toolCall.name === "Agent" && Boolean(nativeSubagent);
  const subAgentStatus = toolCall.arguments.subAgentStatus as "completed"|"failed"|undefined;
  const subAgentDetail = toolCall.arguments.subAgentDetail as string|undefined;
  const subAgentProgress = toolCall.arguments.subAgentProgress as string|undefined;
  const hasResult = hasToolCallResult(toolCall);

  useEffect(() => {
    if (isDispatch && !subAgentStatus && subAgentProgress) setExpanded(true);
    if (isNativeAgent && (nativeSubagent!.messages.length > 0 || nativeSubagent!.summary)) setExpanded(true);
  }, [isDispatch, isNativeAgent, nativeSubagent, subAgentStatus, subAgentProgress]);

  const isError = isDispatch
    ? subAgentStatus === "failed"
    : isNativeAgent
      ? nativeSubagent!.status === "failed"
      : toolCall.isError;
  const isDone = isDispatch
    ? (!!subAgentStatus || (hasResult && !runningSessionId))
    : isNativeAgent
      ? nativeSubagent!.status !== "running"
      : hasResult;
  const statusColor = isDone ? (isError ? "var(--danger)" : "var(--success)") : "var(--accent)";
  const iconColor = isError ? "var(--danger)" : isDone ? "var(--text-muted)" : "var(--accent)";
  const phrase = isDispatch ? null : toolPhrase(toolCall.name);
  const statusLabel = isError
    ? "错误"
    : phrase
      ? ""
      : isNativeAgent
        ? nativeSubagent!.status === "stopped" ? "已停止" : isDone ? "已完成" : "运行中"
      : isDispatch
        ? (subAgentStatus === "failed" ? "失败" : isDone ? "已完成" : "运行中")
        : (isDone ? "完成" : "执行中");

  const previewLabel = isNativeAgent
    ? nativeSubagent!.description
    : isDispatch
    ? (() => {
        const t = (toolCall.arguments.task as string) ?? "";
        const first = t.split("\n")[0];
        return first.length > 80 ? first.slice(0, 80) + "…" : first;
      })()
    : toolPreview(toolCall.name, toolCall.arguments);

  const toolLabel = isNativeAgent
    ? `@${nativeSubagent!.agentName ?? "agent"}`
    : isDispatch
      ? `@${(toolCall.arguments.agentName as string) ?? "agent"}`
      : toolActivityLabel(toolCall.name) ?? toolCall.name;

  const family = toolFamily(toolCall.name);
  const showStatus = !isDone || Boolean(isError) || Boolean(statusLabel);

  const header = (
    <>
      <span className="tool-call-shell__icon">
        <ToolActionIcon name={toolCall.name} color={iconColor} />
      </span>
      <span
        className="tool-call-shell__label"
        title={phrase ? toolCall.name : undefined}
        style={{ fontFamily: phrase ? "var(--font-body)" : "var(--font-mono)", fontSize: 11.5, color: "var(--text-primary)", fontWeight: 600, flexShrink: 0 }}
      >
        {toolLabel}
      </span>
      {previewLabel && (
        <span className="tool-call-shell__preview" style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {previewLabel}
        </span>
      )}
      {!previewLabel && <span style={{ flex: 1 }} />}
      {showStatus && (
        <span className="tool-call-shell__state" style={{ color: statusColor }}>
          <StatusIcon isDone={isDone} isError={!!isError} color={statusColor} />
          {statusLabel && <span>{statusLabel}</span>}
        </span>
      )}
    </>
  );

  return (
    <CardShell statusColor={statusColor} isDone={isDone} expanded={expanded} onToggle={() => setExpanded(!expanded)} header={header} maxBodyHeight={800}>
      {/* Arguments */}
      {isNativeAgent ? (
        <NativeAgentActivity activity={nativeSubagent!} />
      ) : isDispatch ? (
        <DispatchArgs arguments={toolCall.arguments} />
      ) : family === "command" && typeof toolCall.arguments.command === "string" ? (
        <>
          {typeof toolCall.arguments.cwd === "string" && toolCall.arguments.cwd && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>工作目录 {toolCall.arguments.cwd}</div>
          )}
          <CollapsiblePre label="命令" content={toolCall.arguments.command} maxPreviewLines={6} maxPreviewHeight={160} />
        </>
      ) : (
        <ArgumentsBlock raw={JSON.stringify(toolCall.arguments, null, 2)} />
      )}
      {/* Generic result */}
      {toolCall.result && !isDispatch && !isNativeAgent && (
        <CollapsiblePre label={toolCall.isError ? "错误信息" : "返回结果"} content={toolCall.result} error={toolCall.isError} maxPreviewHeight={240} />
      )}
      {/* Dispatch: summary / progress */}
      {isDispatch && subAgentStatus && subAgentDetail && (
        <CollapsiblePre label={subAgentStatus === "failed" ? "错误信息" : "执行摘要"} content={subAgentDetail} error={subAgentStatus === "failed"} maxPreviewHeight={180} />
      )}
      {isDispatch && !subAgentStatus && subAgentProgress && (!!runningSessionId || !hasResult) && (
        <div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>实时输出</div>
          <pre style={{ fontSize: 11, color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "var(--font-mono)", padding: "9px 11px", borderRadius: 7, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderLeft: "3px solid var(--accent)", maxHeight: 240, overflow: "auto", margin: 0, lineHeight: 1.6, boxSizing: "border-box", maxWidth: "100%" }}>
            {subAgentProgress}<span style={{ display: "inline-block", width: "0.5em", height: "1em", background: "var(--accent)", verticalAlign: "text-bottom", animation: "blink 1s step-end infinite" }}>&#8203;</span>
          </pre>
        </div>
      )}
      {isDispatch && !subAgentStatus && !subAgentProgress && !!runningSessionId && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 0", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{
              width: 5, height: 5, borderRadius: "50%",
              background: "var(--accent)",
              display: "inline-block",
              animation: "wave 1.1s ease-in-out infinite",
              animationDelay: `${i * 0.16}s`,
            }} />
          ))}
          等待子 agent 响应...
        </div>
      )}
      {isDispatch && toolCall.arguments.subSessionId && onSelectSession && (
        <button onClick={() => onSelectSession(toolCall.arguments.subSessionId as string)} style={{ alignSelf: "flex-start", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border-default)", background: "var(--accent-dim)", color: "var(--accent)", fontSize: 11, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, transition: "background 0.15s" }} onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--accent)"; (e.currentTarget as HTMLButtonElement).style.color = "white"; }} onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)"; }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2z"/><path d="M12 12c-5.33 0-8 2.67-8 4v2h16v-2c0-1.33-2.67-4-8-4z"/></svg>
          查看子会话
        </button>
      )}
    </CardShell>
  );
}

export interface ToolCallGroupItem {
  toolCall: ToolCallData;
  beforeContent?: string;
  progress?: RuntimeProgress;
  nativeSubagent?: NativeSubagentActivity;
}

export function ToolCallGroup({ items, onSelectSession }: { items: ToolCallGroupItem[]; onSelectSession?: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const first = items[0]?.toolCall;
  const phrase = first ? toolPhrase(first.name) : null;
  if (!first || !phrase || items.length < 2) return null;

  const isDone = items.every(({ toolCall }) => hasToolCallResult(toolCall));
  const errorCount = items.filter(({ toolCall }) => toolCall.isError).length;
  const statusColor = errorCount > 0 ? "var(--danger)" : isDone ? "var(--text-muted)" : "var(--accent)";
  const actionLabel = toolActivityLabel(first.name) ?? phrase.done;
  const disclosureLabel = `${actionLabel}，${items.length} 项，${expanded ? "收起" : "展开"}`;

  return (
    <div className="tool-call-group">
      <button
        type="button"
        className="tool-call-group__summary"
        aria-expanded={expanded}
        aria-label={disclosureLabel}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-call-group__icon" aria-hidden="true">
          <ToolActionIcon name={first.name} color={statusColor} />
        </span>
        <span className="tool-call-group__label">{actionLabel}</span>
        <span className="tool-call-group__count">{items.length} 项</span>
        <span className="tool-call-group__spacer" />
        {errorCount > 0 && <span className="tool-call-group__error">{errorCount} 项失败</span>}
        {!isDone && <StatusIcon isDone={false} color={statusColor} size={11} />}
        <ChevronRight className="tool-call-group__chevron" size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="tool-call-group__items">
          {items.map(({ toolCall, beforeContent, progress, nativeSubagent }) => (
            <ToolCallCard
              key={toolCall.id}
              toolCall={toolCall}
              beforeContent={beforeContent}
              progress={progress}
              nativeSubagent={nativeSubagent}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ToolCallCard({ toolCall, onSelectSession, beforeContent, progress, nativeSubagent }: ToolCallProps) {
  const card = toolCall.name === "write_file"
    ? <WriteFileCard toolCall={toolCall} beforeContent={beforeContent} />
    : toolCall.name === "read_file"
      ? <ReadFileCard toolCall={toolCall} />
      : toolCall.name === "str_replace"
        ? <StrReplaceCard toolCall={toolCall} />
        : <GenericToolCard toolCall={toolCall} onSelectSession={onSelectSession} nativeSubagent={nativeSubagent} />;
  return (
    <div className="tool-call-with-progress">
      {card}
      {progress && <RuntimeProgressRow progress={progress} compact />}
    </div>
  );
}

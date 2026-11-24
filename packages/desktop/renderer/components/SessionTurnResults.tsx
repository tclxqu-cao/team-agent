import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FileDiff, FileText, LoaderCircle } from "lucide-react";
import type { SessionToolResultBody, SessionToolResultRef } from "@agent/core";
import type { ChatMessage } from "../stores/agentStore";
import { collectTurnArtifacts, collectTurnChanges, groupTurnChanges, restoreOmittedPatchFiles, traceNeedsTurnResults, turnFileName, turnResultMessages, type SessionTurnResult, type TurnFileChange } from "../lib/session-turn-results";
import MessageArtifactLink from "./MessageArtifactLink";
import ArtifactFileActions from "./ArtifactFileActions";
import ToolCallCard from "./ToolCallCard";
import { patchChanges } from "../lib/file-tool-presentation";
import "../styles/session-turn-results.css";

type ToolCall = NonNullable<ChatMessage["toolCalls"]>[number];
type LoadToolResult = (ref: SessionToolResultRef) => Promise<SessionToolResultBody>;
const CHANGE_LABEL = { add: "新增", update: "编辑", delete: "删除" };

export function TurnResultDisclosure({ label, className, summaryClassName, title, children }: { label: ReactNode; className?: string; summaryClassName?: string; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={summaryClassName} title={title}>{label}</summary>
    {open && children}
  </details>;
}

function ResultTool({ tool, before, onLoadResult }: { tool: ToolCall; before?: string; onLoadResult: LoadToolResult }) {
  const [body, setBody] = useState<SessionToolResultBody>();
  return <ToolCallCard detailsOnly beforeContent={before}
    toolCall={body ? { ...tool, result: body.content, isError: body.isError ?? tool.isError } : tool}
    onLoadResult={async ref => setBody(await onLoadResult(ref))} />;
}

function PatchBody({ patch }: { patch: string }) {
  return <pre className="turn-results__patch" tabIndex={0} aria-label="文件差异">{patch.split("\n").map((line, lineIndex) => (
    <span key={lineIndex} className={line.startsWith("+") ? "is-added" : line.startsWith("-") ? "is-removed" : undefined}>{line}{"\n"}</span>
  ))}</pre>;
}

function FileChangeBody({ change, onLoadResult }: { change: TurnFileChange; onLoadResult: LoadToolResult }) {
  const [patch, setPatch] = useState(change.patch);
  if (patch !== undefined) return <PatchBody patch={patch} />;
  return <ResultTool tool={change.tool} before={change.before} onLoadResult={async ref => {
    const body = await onLoadResult(ref);
    const name = change.recordedPath;
    const entry = name && patchChanges({}, body.content).find(item => item.path === name);
    if (entry && typeof entry.diff === "string") setPatch(entry.diff);
    return body;
  }} />;
}

export function TurnChangeDetails({ changes, onLoadResult, onOpenArtifact }: {
  changes: TurnFileChange[];
  onLoadResult: LoadToolResult;
  onOpenArtifact?: (path: string) => void;
}) {
  const latest = changes[changes.length - 1];
  return <div className="turn-results__detail">
    {latest.operation !== "delete" && onOpenArtifact && <MessageArtifactLink path={latest.path} label={turnFileName(latest.path)} onOpen={onOpenArtifact}>打开文件</MessageArtifactLink>}
    {changes.map((change, index) => <div key={`${change.tool.id}:${change.tool.resultRef?.revision}:${index}`}>
      {changes.length > 1 && <small>{CHANGE_LABEL[change.operation]}</small>}
      <FileChangeBody change={change} onLoadResult={onLoadResult} />
    </div>)}
  </div>;
}

function TurnChangeStats({ changes }: { changes: TurnFileChange[] }) {
  const stats = changes.every(change => change.stats) ? changes.reduce((total, change) => ({
    added: total.added + change.stats!.added,
    removed: total.removed + change.stats!.removed,
  }), { added: 0, removed: 0 }) : null;
  return stats && <span className="turn-results__stats"><span className="is-added">+{stats.added}</span> <span className="is-removed">−{stats.removed}</span></span>;
}

interface TurnFile {
  path: string;
  artifactLabel?: string;
  changes?: TurnFileChange[];
}

function TurnFileRow({ file, onLoadResult, onOpenArtifact, trailing }: {
  file: TurnFile;
  onLoadResult: LoadToolResult;
  onOpenArtifact?: (path: string) => void;
  trailing?: ReactNode;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const changeId = useId();
  const name = turnFileName(file.path);
  const { artifactLabel } = file;
  const latestChange = file.changes?.at(-1);
  const changeAction = {
    "aria-expanded": showChanges,
    "aria-controls": changeId,
    "aria-label": `${showChanges ? "收起改动" : "查看改动"} ${name}`,
    onClick: () => setShowChanges(value => !value),
  };
  return <div className="turn-results__file">
    <div className="turn-results__file-row">
      {artifactLabel && onOpenArtifact ? <MessageArtifactLink path={file.path} label={artifactLabel} onOpen={onOpenArtifact}>
        <FileText size={14} aria-hidden="true" /><span className="turn-results__label">{name}</span>
      </MessageArtifactLink> : file.changes && <button className="turn-results__file-title" type="button" title={file.path} {...changeAction}>
        <FileDiff size={14} aria-hidden="true" /><span className="turn-results__label">{name}</span>
        <TurnChangeStats changes={file.changes} />
      </button>}
      <div className="turn-results__file-controls">
        {onOpenArtifact && latestChange?.operation !== "delete" && (artifactLabel || latestChange) && (
          <ArtifactFileActions key={file.path} path={file.path} label={artifactLabel || name} />
        )}
        {artifactLabel && onOpenArtifact && file.changes && <button className="turn-results__file-action" type="button"
          title={changeAction["aria-label"]} {...changeAction}><FileDiff size={14} aria-hidden="true" /></button>}
        {trailing}
      </div>
    </div>
    {file.changes && <div id={changeId} hidden={!showChanges}>
      {showChanges && <TurnChangeDetails changes={file.changes} onLoadResult={onLoadResult} onOpenArtifact={onOpenArtifact} />}
    </div>}
  </div>;
}

interface Props {
  turn: SessionTurnResult;
  workspacePath?: string | null;
  loadTrace: (trace: SessionTurnResult["traces"][number]) => Promise<ChatMessage[]>;
  onLoadResult: LoadToolResult;
  onOpenArtifact?: (path: string) => void;
}

export default function SessionTurnResults({ turn, workspacePath, loadTrace, onLoadResult, onOpenArtifact }: Props) {
  const footerRef = useRef<HTMLElement>(null);
  const [nativeHistory, setNativeHistory] = useState<ReadonlyMap<string, ChatMessage[]>>(new Map());
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">("idle");
  const [attempt, setAttempt] = useState(0);
  const [showMoreFiles, setShowMoreFiles] = useState(false);
  const moreFilesId = useId();
  const trace = turn.traces.find(traceNeedsTurnResults);
  useEffect(() => {
    const footer = footerRef.current;
    if (!trace || !footer || attempt || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setAttempt(value => value || 1);
      }
    });
    observer.observe(footer);
    return () => observer.disconnect();
  }, [attempt, trace?.turnId]);

  useEffect(() => {
    if (!trace || !attempt || nativeHistory.has(trace.turnId)) return;
    let active = true;
    setLoadState("loading");
    void loadTrace(trace).then(messages => restoreOmittedPatchFiles(messages, ref => {
      if (!active) throw new DOMException("Turn result is no longer visible", "AbortError");
      return onLoadResult(ref);
    })).then(messages => {
      if (!active) return;
      setNativeHistory(new Map([[trace.turnId, messages]]));
      setLoadState("idle");
    }, () => { if (active) setLoadState("failed"); });
    return () => { active = false; };
    // Reconciliation can replace the carrier while the same native read is in flight.
  }, [attempt, loadTrace, nativeHistory, onLoadResult, trace?.turnId, trace?.revision]);

  const messages = useMemo(() => turnResultMessages(turn, nativeHistory), [turn, nativeHistory]);
  const changes = useMemo(() => collectTurnChanges(messages, workspacePath), [messages, workspacePath]);
  const files = useMemo(() => groupTurnChanges(changes), [changes]);
  const artifacts = useMemo(() => collectTurnArtifacts(messages, changes, workspacePath), [messages, changes, workspacePath]);
  const showLookup = trace && !nativeHistory.has(trace.turnId);
  if (!files.size && !(onOpenArtifact && artifacts.length) && !showLookup) return null;

  const artifactLabels = new Map(onOpenArtifact ? artifacts.map(artifact => [artifact.path, artifact.label]) : []);
  const resultPaths = new Set([...artifactLabels.keys(), ...files.keys()]);
  const [firstFile, ...moreFiles] = [...resultPaths].map(path => ({ path, artifactLabel: artifactLabels.get(path), changes: files.get(path) }));
  const moreFilesLabel = showMoreFiles ? "收起其余文件" : `展开其余 ${moreFiles.length} 个文件`;

  return <section className="turn-results" aria-label="本轮结果" ref={footerRef}>
    {firstFile && <div className="turn-results__files" role="group" aria-label="本轮文件">
      <TurnFileRow key={firstFile.path} file={firstFile} onLoadResult={onLoadResult} onOpenArtifact={onOpenArtifact}
        trailing={moreFiles.length > 0 && <button className="turn-results__file-action turn-results__file-action--more" type="button"
          aria-controls={moreFilesId} aria-expanded={showMoreFiles} aria-label={moreFilesLabel} title={moreFilesLabel}
          onClick={() => setShowMoreFiles(value => !value)}>
          <ChevronDown size={13} aria-hidden="true" />
        </button>} />
      {moreFiles.length > 0 && <div id={moreFilesId} hidden={!showMoreFiles}>
        {showMoreFiles && moreFiles.map(file => <TurnFileRow key={file.path} file={file} onLoadResult={onLoadResult} onOpenArtifact={onOpenArtifact} />)}
      </div>}
    </div>}
    {!firstFile && showLookup && <button className="turn-results__link" type="button" disabled={loadState === "loading"} onClick={() => setAttempt(value => value + 1)}>
      {loadState === "loading" && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
      {loadState === "failed" ? "重试读取" : loadState === "loading" ? "读取中" : "读取结果"}
    </button>}
  </section>;
}

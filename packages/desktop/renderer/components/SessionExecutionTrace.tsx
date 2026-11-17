import { useMemo, type ReactNode } from "react";
import type { NativeSubagentActivity, RuntimeProgress, SessionToolResultRef } from "@agent/core";
import type { SessionExecutionGroup } from "../lib/session-execution-trace";
import { executionActivityRows } from "../lib/execution-activity-blocks";
import ExecutionTrace, { ExecutionTraceContent, useExecutionTraceDisclosure } from "./ExecutionTrace";

interface SessionExecutionTraceProps {
  group: SessionExecutionGroup;
  active?: boolean;
  renderContent: (text: string) => ReactNode;
  runtimeProgress: RuntimeProgress[];
  nativeSubagents: Record<string, NativeSubagentActivity>;
  onLoadResult: (ref: SessionToolResultRef) => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
  workspacePath?: string | null;
  onOpenArtifact?: (path: string) => void;
}

export default function SessionExecutionTrace({ group, active = group.isRunning, ...contentProps }: SessionExecutionTraceProps) {
  const { expanded, setExpanded } = useExecutionTraceDisclosure(group.id, group.isRunning);
  const hasActivity = useMemo(() => executionActivityRows(group.messages).length > 0, [group.messages]);
  if (!group.isRunning && !hasActivity) return null;
  return (
    <ExecutionTrace
      messageId={group.id}
      isRunning={group.isRunning}
      durationMs={group.durationMs}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <ExecutionTraceContent messages={group.messages} active={active && group.isRunning} {...contentProps} />
    </ExecutionTrace>
  );
}

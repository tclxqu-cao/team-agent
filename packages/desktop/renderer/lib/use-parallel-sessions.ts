import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateParallelSessionsInput, ParallelConversation, SessionGoalState, UnifiedSessionSummary } from "../global";
import type { ParallelAgentStatus } from "../components/ParallelAgentTabs";
import { useAgentStore, type StreamEvent } from "../stores/agentStore";
import { hasPendingSessionQuestion } from "./sidebar-session-status";
import { isPageActive } from "./page-activity";
import { dispatchParallelMessages, type FailedParallelMessage, type ParallelMessage } from "./parallel-message-dispatch";
import { parallelRunOptions } from "./parallel-run-options";
import { ParallelFailedMessageRepository } from "./parallel-failed-messages";
import { IndexedDbSessionImageDraftRepository } from "./session-image-draft";

export function useParallelSessions({ sessionId, onSelect, onQueueState, profileId }: {
  sessionId: string | null;
  onSelect?: (session: UnifiedSessionSummary) => void | Promise<void>;
  onQueueState: (state: SessionGoalState, id: string) => void;
  profileId?: string;
}) {
  const [storedGroup, setGroup] = useState<ParallelConversation | null>(null);
  const group = sessionId && storedGroup?.members.some(member => member.id === sessionId) ? storedGroup : null;
  const [recipients, setRecipients] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ParallelAgentStatus>>({});
  const [failed, setFailed] = useState<FailedParallelMessage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const failedRef = useRef<FailedParallelMessage[]>([]);
  const failureGeneration = useRef(0);
  const failureRepository = useRef<ParallelFailedMessageRepository | null>(null);
  if (!failureRepository.current) {
    try {
      if (typeof localStorage !== "undefined") failureRepository.current = new ParallelFailedMessageRepository(localStorage, new IndexedDbSessionImageDraftRepository());
    } catch { /* Single-Agent chats and in-memory retries also work with storage disabled. */ }
  }
  const cache = useRef(new Map<string, ParallelConversation>());
  const currentGroupId = useRef<string | null>(null);
  const selectGeneration = useRef(0);
  const queueStateCallback = useRef(onQueueState);
  queueStateCallback.current = onQueueState;
  const statusRevisions = useRef(new Map<string, number>());

  const remember = useCallback((value: ParallelConversation) => {
    for (const member of value.members) cache.current.set(member.id, value);
    if (currentGroupId.current !== value.id) {
      currentGroupId.current = value.id;
      let selected = value.members.map(member => member.id);
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`agentroam.parallel-recipients.v1:${value.id}`) || "null");
        if (Array.isArray(saved)) {
          const retained = selected.filter(id => saved.includes(id));
          if (retained.length) selected = retained;
        }
      } catch { /* Keep the explicit all-participant default when storage is unavailable. */ }
      setRecipients(selected);
      setFailed([]);
      failedRef.current = [];
      const generation = ++failureGeneration.current;
      void failureRepository.current?.read(value).then(restored => {
        if (currentGroupId.current !== value.id || failureGeneration.current !== generation) return;
        failedRef.current = restored; setFailed(restored);
      }).catch(() => undefined);
    }
    setGroup(value);
  }, []);

  useEffect(() => {
    selectGeneration.current += 1;
    if (!sessionId) { setGroup(null); currentGroupId.current = null; setError(null); return; }
    const cached = cache.current.get(sessionId);
    if (cached) { remember(cached); return; }
    setGroup(null);
    let cancelled = false;
    if (typeof window.agentApi?.getParallelSessionGroup !== "function") return;
    void window.agentApi.getParallelSessionGroup(sessionId).then(value => {
      if (cancelled) return;
      if (value) remember(value);
      else currentGroupId.current = null;
    }).catch(() => {
      // Existing single-Agent chats also work against a server predating associations.
    });
    return () => { cancelled = true; };
  }, [sessionId, remember]);

  const updateStatus = useCallback((id: string, status: ParallelAgentStatus) => {
    statusRevisions.current.set(id, (statusRevisions.current.get(id) ?? 0) + 1);
    setStatuses(previous => previous[id] === status ? previous : { ...previous, [id]: status });
  }, []);

  useEffect(() => {
    if (!group) return;
    const ids = new Set(group.members.map(member => member.id));
    return window.agentApi.onEvent(value => {
      const event = value as StreamEvent;
      if (!event._sid || !ids.has(event._sid)) return;
      if (event.type === "ask_user") updateStatus(event._sid, "needs-input");
      else if (event.type === "error") updateStatus(event._sid, event._preserveActiveRun ? "running" : "failed");
      else if (event.type === "done" || event.type === "turn_aborted") {
        updateStatus(event._sid, event.type === "turn_aborted" || (event.result && "status" in event.result && event.result.status !== "completed") ? "failed" : "completed");
      } else if (["run_admitted", "thinking", "text_chunk", "tool_call", "approval_resolved"].includes(event.type)) {
        updateStatus(event._sid, hasPendingSessionQuestion(useAgentStore.getState().getMessagesForSession(event._sid)) ? "needs-input" : "running");
      }
    });
  }, [group?.id, updateStatus]);

  useEffect(() => {
    if (!group) return;
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending || !isPageActive()) return;
      pending = true;
      try {
        await Promise.allSettled(group.members.map(async member => {
          const revision = statusRevisions.current.get(member.id) ?? 0;
          const state = await window.agentApi.getSessionGoals(member.id);
          if (cancelled || revision !== (statusRevisions.current.get(member.id) ?? 0)) return;
          const question = hasPendingSessionQuestion(useAgentStore.getState().getMessagesForSession(member.id));
          const last = state.history.reduce<SessionGoalState["history"][number] | undefined>((latest, item) => !latest || item.updatedAt > latest.updatedAt ? item : latest, undefined);
          updateStatus(member.id, question ? "needs-input" : state.active ? "running"
            : last ? last.status === "completed" ? "completed" : "failed" : "idle");
        }));
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [group?.id, updateStatus]);

  const create = async (input: CreateParallelSessionsInput) => {
    const value = await window.agentApi.createParallelSessions(input);
    for (const member of value.members) cache.current.set(member.id, value);
    return value;
  };

  const select = async (member: UnifiedSessionSummary, beforeSelect?: () => void | Promise<void>) => {
    if (member.id === sessionId) return;
    const generation = ++selectGeneration.current;
    setError(null);
    try {
      const detail = await window.agentApi.getSession(member.id, { limit: 1, view: "core" }) as UnifiedSessionSummary | null;
      if (!detail || detail.id !== member.id || detail.agentType !== member.agentType) throw new Error("该 Agent 的会话已不可访问");
      if (generation !== selectGeneration.current) return;
      await beforeSelect?.();
      if (generation !== selectGeneration.current) return;
      await onSelect?.(detail);
    } catch (cause) {
      if (generation !== selectGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "切换 Agent 会话失败");
    }
  };

  const submit = async (attempts: Array<{ member: UnifiedSessionSummary; message: ParallelMessage }>) => {
    if (busy.current) return { accepted: [] as string[], failed: [] as FailedParallelMessage[] };
    busy.current = true;
    setSubmitting(true);
    const targetGroup = attempts[0] ? cache.current.get(attempts[0].member.id) : undefined;
    let previousFailures = currentGroupId.current === targetGroup?.id ? failedRef.current : [];
    failureGeneration.current += 1;
    try {
      if (targetGroup && !previousFailures.length) previousFailures = await failureRepository.current?.read(targetGroup) ?? [];
      const store = useAgentStore.getState();
      for (const { member, message } of attempts) {
        const existing = store.getMessagesForSession(member.id).find(item => item.id === message.sourceMessageId);
        if (existing) store.updateMessage(existing.id, item => ({ ...item, sendState: "pending" }), member.id);
        else store.addMessage({
          id: message.sourceMessageId, role: "user", content: message.content, images: message.images,
          agentName: message.agentName, timestamp: Date.now(), sendState: "pending", awaitingHistory: true,
        }, member.id);
      }
      const result = await dispatchParallelMessages(attempts, {
        enqueue: (id, message) => window.agentApi.enqueueSessionMessage(id, message),
        prepare: async (member, message) => ({ ...message, runOptions: message.runOptions ?? await parallelRunOptions(window.agentApi, member, profileId) }),
        admitted: (member, state) => {
          queueStateCallback.current(state, member.id);
          updateStatus(member.id, state.active ? "running" : "idle");
          store.updateMessage(attempts.find(attempt => attempt.member.id === member.id)!.message.sourceMessageId,
            item => ({ ...item, sendState: undefined }), member.id);
        },
      });
      const attempted = new Set(attempts.map(attempt => `${attempt.member.id}:${attempt.message.sourceMessageId}`));
      const nextFailures = [...previousFailures.filter(item => !attempted.has(`${item.member.id}:${item.message.sourceMessageId}`)), ...result.failed];
      if (currentGroupId.current === targetGroup?.id) { failedRef.current = nextFailures; setFailed(nextFailures); }
      if (targetGroup) {
        try { await failureRepository.current?.write(targetGroup, nextFailures); }
        catch { if (currentGroupId.current === targetGroup.id) setError("未能保存失败消息，请保持此页面并重试发送"); }
      }
      for (const failure of result.failed) {
        store.updateMessage(failure.message.sourceMessageId, item => ({ ...item, sendState: "failed" }), failure.member.id);
      }
      return result;
    } finally { busy.current = false; setSubmitting(false); }
  };

  const changeRecipients = (ids: string[]) => {
    if (!group) return;
    const selected = group.members.filter(member => ids.includes(member.id)).map(member => member.id);
    if (!selected.length) return;
    setRecipients(selected);
    try { localStorage.setItem(`agentroam.parallel-recipients.v1:${group.id}`, JSON.stringify(selected)); } catch { /* Selection remains in memory. */ }
  };
  return { group, recipients, setRecipients: changeRecipients, statuses, failed, submitting, error, create, activate: remember, select, submit,
    retry: (failure: FailedParallelMessage) => submit([failure]),
    isRunning: (id: string | null) => Boolean(id && ["running", "needs-input"].includes(statuses[id])),
  };
}

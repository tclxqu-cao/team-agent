import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CollaborationDiscussionMode,
  CollaborationDiscussionState,
  CollaborationDiscussionSummary,
  CollaborationGroup,
} from "@agent/core/domain/collaboration/types";
import { collaborationRequest } from "./client";

export function useCollaborationDiscussion(groupId: string, initialDiscussionId?: string) {
  const [group, setGroup] = useState<CollaborationGroup | null>(null);
  const [history, setHistory] = useState<CollaborationDiscussionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [discussion, setDiscussion] =
    useState<CollaborationDiscussionState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(0);
  const creating = useRef<Promise<CollaborationDiscussionState | null> | null>(
    null,
  );
  const sending = useRef(false);
  const begin = () => {
    pending.current++;
    setBusy(true);
  };
  const end = () => {
    pending.current--;
    setBusy(pending.current > 0);
  };
  const current = useRef({ groupId, selected, revision: -1 });
  current.current.groupId = groupId;
  current.current.selected = selected;
  const select = useCallback(
    (id: string | null) => {
      current.current.selected = id;
      current.current.revision = -1;
      setSelected(id);
      setDiscussion(null);
      setError("");
      try {
        if (id) localStorage.setItem(`collaboration:${groupId}:discussion`, id);
      } catch {
        /* private storage can be disabled */
      }
    },
    [groupId],
  );
  const refreshHistory = useCallback(async () => {
    const list = await collaborationRequest<CollaborationDiscussionSummary[]>({
      action: "discussions",
      groupId,
    });
    if (current.current.groupId === groupId) setHistory(list);
    return list;
  }, [groupId]);
  useEffect(() => {
    let live = true;
    setGroup(null);
    setHistory([]);
    select(null);
    void Promise.all([
      collaborationRequest<CollaborationGroup>({ action: "group", groupId }),
      refreshHistory(),
    ])
      .then(([g, list]) => {
        if (!live) return;
        setGroup(g);
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(`collaboration:${groupId}:discussion`);
        } catch {
          /* optional */
        }
        saved = initialDiscussionId || new URLSearchParams(window.location.search).get("discussionId") || saved;
        select(list.find((d) => d.id === saved)?.id || list[0]?.id || null);
      })
      .catch((err) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [groupId, refreshHistory, select, initialDiscussionId]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const snapshot = await collaborationRequest<
          CollaborationDiscussionState | { unchanged: true; revision: number }
        >({
          action: "discussion",
          discussionId: selected,
          afterRevision:
            current.current.revision < 0 ? undefined : current.current.revision,
        });
        if (!live || current.current.selected !== selected) return;
        if (
          !("unchanged" in snapshot) &&
          snapshot.revision >= current.current.revision
        ) {
          current.current.revision = snapshot.revision;
          setDiscussion(snapshot);
          await refreshHistory();
        }
        setError("");
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, refreshHistory]);
  const create = (): Promise<CollaborationDiscussionState | null> => {
    if (creating.current) return creating.current;
    begin();
    creating.current = (async () => {
      const state = await collaborationRequest<CollaborationDiscussionState>({
        action: "createDiscussion",
        groupId,
      });
      if (current.current.groupId !== groupId) return null;
      select(state.id);
      current.current.revision = state.revision;
      setDiscussion(state);
      await refreshHistory();
      return state;
    })().finally(() => {
      creating.current = null;
      end();
    });
    return creating.current;
  };
  const act = async (action: "stop" | "resume") => {
    if (!selected) return;
    begin();
    try {
      const snapshot = await collaborationRequest<CollaborationDiscussionState>(
        { action, discussionId: selected },
      );
      if (
        current.current.selected === selected &&
        snapshot.revision >= current.current.revision
      ) {
        current.current.revision = snapshot.revision;
        setDiscussion(snapshot);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      end();
    }
  };
  const setMode = async (mode: CollaborationDiscussionMode) => {
    if (!selected || discussion?.mode === mode) return;
    begin();
    try {
      const snapshot = await collaborationRequest<CollaborationDiscussionState>({
        action: "setMode",
        discussionId: selected,
        mode,
      });
      if (
        current.current.selected === selected &&
        snapshot.revision >= current.current.revision
      ) {
        current.current.revision = snapshot.revision;
        setDiscussion(snapshot);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      end();
    }
  };
  const send = async (text: string, messageId: string) => {
    if (sending.current) return false;
    sending.current = true;
    begin();
    setError("");
    try {
      const target = selected || (await create())?.id;
      if (!target) return false;
      const snapshot = await collaborationRequest<CollaborationDiscussionState>(
        { action: "send", discussionId: target, text, messageId },
      );
      if (
        current.current.selected === target &&
        snapshot.revision >= current.current.revision
      ) {
        current.current.revision = snapshot.revision;
        setDiscussion(snapshot);
      }
      await refreshHistory();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      sending.current = false;
      end();
    }
  };
  const updateRole = async (memberId: string, role: string) => {
    const updated = await collaborationRequest<CollaborationGroup>({
      action: "updateRole",
      groupId,
      memberId,
      role,
    });
    if (current.current.groupId === groupId) setGroup(updated);
  };
  return {
    group: discussion?.groupSnapshot && group
      ? { ...discussion.groupSnapshot, name: group.name } : group,
    history,
    selected,
    discussion,
    error,
    busy,
    select,
    create,
    act,
    setMode,
    send,
    setError,
    updateRole,
  };
}

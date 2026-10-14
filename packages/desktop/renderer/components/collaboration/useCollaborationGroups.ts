import { useCallback, useEffect, useRef, useState } from "react";
import type { CollaborationGroup } from "@agent/core/domain/collaboration/types";
import { collaborationRequest } from "./client";

/** Presentation state; the service remains authoritative across reloads. */
export function useCollaborationGroups() {
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    setLoading(true);
    try {
      const list = await collaborationRequest<CollaborationGroup[]>({
        action: "groups",
      });
      if (request.current === version) {
        setGroups(list);
        setError("");
      }
    } catch (err) {
      if (request.current === version)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request.current === version) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      request.current++;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  return { groups, loading, error, refresh };
}

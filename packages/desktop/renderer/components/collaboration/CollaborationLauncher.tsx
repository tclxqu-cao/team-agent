import { useCallback, useEffect, useState } from "react";
import { Users, ChevronRight } from "lucide-react";
import type { CollaborationGroup } from "@agent/core/domain/collaboration/types";
import { collaborationRequest } from "./client";

export default function CollaborationLauncher({
  refreshKey,
  onOpen,
}: {
  refreshKey: number;
  onOpen: (group: CollaborationGroup) => void;
}) {
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const refresh = useCallback(() => {
    void collaborationRequest<CollaborationGroup[]>({ action: "groups" })
      .then(setGroups)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);
  return (
    <>
      {groups.length > 0 && (
        <div className="collab-group-list" aria-label="协作群">
          <span className="collab-eyebrow">协作群</span>
          {groups.map((group) => (
            <button
              key={group.id}
              title={group.name}
              onClick={() => onOpen(group)}
            >
              <Users size={15} />
              <span>{group.name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

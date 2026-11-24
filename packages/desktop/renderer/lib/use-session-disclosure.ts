import { useState } from "react";

export function useSessionDisclosure() {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  function toggle(id: string) {
    setExpandedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return { expandedIds, toggle, collapseAll: () => setExpandedIds(new Set()) };
}

interface SessionLink {
  id: string;
  agentType: string;
  parentSessionId?: string;
}

export interface SessionTreeNode<T> {
  session: T;
  children: SessionTreeNode<T>[];
}

/** Keep every loaded descendant when a project window is paginated or cached. */
export function collectSessionSubtree<T extends SessionLink>(
  roots: readonly T[],
  childrenByParent: Readonly<Record<string, readonly T[]>>,
): T[] {
  const rows = new Map(roots.map(session => [session.id, session]));
  for (const parent of rows.values()) {
    for (const child of childrenByParent[parent.id] ?? []) {
      if (!rows.has(child.id)) rows.set(child.id, child);
    }
  }
  return [...rows.values()];
}

/** Place each branch at its first ranked member while preserving sibling order. */
export function buildSessionTree<T extends SessionLink>(sessions: readonly T[]): SessionTreeNode<T>[] {
  const nodes = new Map(sessions.map(session => [session.id, { session, children: [] } as SessionTreeNode<T>]));
  const roots = new Set<SessionTreeNode<T>>();
  const rootById = new Map<string, SessionTreeNode<T> | undefined>();
  for (const node of nodes.values()) {
    const { session } = node;
    const parent = session.parentSessionId ? nodes.get(session.parentSessionId) : undefined;
    if (parent?.session.agentType === session.agentType) parent.children.push(node);

    const path = new Set<string>();
    let ancestor: SessionTreeNode<T> | undefined = node;
    while (ancestor && !rootById.has(ancestor.session.id)) {
      const { id, parentSessionId } = ancestor.session;
      if (path.has(id)) { ancestor = undefined; break; }
      path.add(id);
      if (!parentSessionId) break;
      const next = nodes.get(parentSessionId);
      ancestor = next?.session.agentType === session.agentType ? next : undefined;
    }
    const root = ancestor && (rootById.has(ancestor.session.id) ? rootById.get(ancestor.session.id) : ancestor);
    for (const id of path) rootById.set(id, root);
    if (root) roots.add(root);
  }
  return [...roots];
}

/** Add context for a search match without including unrelated siblings. */
export function includeSessionAncestors<T extends SessionLink>(matches: readonly T[], known: readonly T[]): T[] {
  const byId = new Map(known.map(session => [session.id, session]));
  const rows = new Map(matches.map(session => [session.id, session]));
  for (const session of matches) {
    let parentId = session.parentSessionId;
    while (parentId && !rows.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent || parent.agentType !== session.agentType) break;
      rows.set(parentId, parent);
      parentId = parent.parentSessionId;
    }
  }
  return [...rows.values()];
}

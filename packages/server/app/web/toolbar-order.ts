/** Move one visible action without losing temporarily hidden actions. */
export function moveToolbarAction<T extends string>(order: readonly T[], source: T, target: T): T[] {
  const from = order.indexOf(source);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}

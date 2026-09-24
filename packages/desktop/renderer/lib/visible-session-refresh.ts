export function refreshableWorkspaceIds(
  visibleWorkspaceIds: Iterable<string>,
  invalidWorkspaceIds: ReadonlySet<string>,
  loadingWorkspaceIds: ReadonlySet<string>,
): string[] {
  return [...visibleWorkspaceIds].filter((workspaceId) => (
    !invalidWorkspaceIds.has(workspaceId) && !loadingWorkspaceIds.has(workspaceId)
  ));
}

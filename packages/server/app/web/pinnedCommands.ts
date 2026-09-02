import type { PinnedCommand } from "@agent/core";

export function movePinnedCommand(
  commands: readonly PinnedCommand[],
  sourceId: string,
  targetId: string,
): PinnedCommand[] {
  const sourceIndex = commands.findIndex((item) => item.id === sourceId);
  const targetIndex = commands.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...commands];
  const next = [...commands];
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

export function createPinnedCommand(command: string, id = crypto.randomUUID()): PinnedCommand {
  return { id, command: command.trim() };
}

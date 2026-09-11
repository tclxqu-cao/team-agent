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

function createPinnedCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // getRandomValues is also available on LAN HTTP pages, unlike randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPinnedCommand(command: string, id = createPinnedCommandId()): PinnedCommand {
  return { id, command: command.trim() };
}

import type { PinnedCommand } from "./entities.js";

export const MAX_PINNED_COMMANDS = 50;
export const MAX_PINNED_COMMAND_LENGTH = 1000;

const DEFAULT_COMMAND_VALUES = ["codex", "claude agents", "opencode", "agent-tui"] as const;

export function defaultPinnedCommands(): PinnedCommand[] {
  return DEFAULT_COMMAND_VALUES.map((command, index) => ({
    id: `default-${index + 1}`,
    command,
  }));
}

export function validatePinnedCommands(value: unknown): PinnedCommand[] {
  if (!Array.isArray(value)) throw new Error("置顶命令必须是数组");
  if (value.length > MAX_PINNED_COMMANDS) throw new Error(`置顶命令最多 ${MAX_PINNED_COMMANDS} 条`);

  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("置顶命令格式无效");
    const id = String((item as Record<string, unknown>).id ?? "").trim();
    const command = String((item as Record<string, unknown>).command ?? "").trim();
    if (!id || id.length > 128 || /[\r\n\0]/.test(id)) throw new Error("置顶命令 ID 无效");
    if (ids.has(id)) throw new Error("置顶命令 ID 不能重复");
    if (!command) throw new Error("置顶命令不能为空");
    if (command.length > MAX_PINNED_COMMAND_LENGTH) throw new Error(`单条命令最多 ${MAX_PINNED_COMMAND_LENGTH} 个字符`);
    if (/[\r\n\0]/.test(command)) throw new Error("置顶命令只能包含一行");
    ids.add(id);
    return { id, command };
  });
}

export function parseStoredPinnedCommands(value: string | null | undefined): PinnedCommand[] {
  if (value == null) return defaultPinnedCommands();
  try {
    return validatePinnedCommands(JSON.parse(value));
  } catch {
    return defaultPinnedCommands();
  }
}

import { describe, expect, it } from "vitest";
import { createPinnedCommand, movePinnedCommand } from "./pinnedCommands";

describe("pinned command ordering", () => {
  const commands = [
    { id: "codex", command: "codex" },
    { id: "claude", command: "claude agents" },
    { id: "opencode", command: "opencode" },
  ];

  it("moves an item to the target position without changing its identity", () => {
    expect(movePinnedCommand(commands, "opencode", "codex").map((item) => item.id))
      .toEqual(["opencode", "codex", "claude"]);
  });

  it("keeps the list stable when an id is missing", () => {
    expect(movePinnedCommand(commands, "missing", "codex")).toEqual(commands);
  });

  it("trims a manually entered command", () => {
    expect(createPinnedCommand("  npm test  ", "test")).toEqual({ id: "test", command: "npm test" });
  });
});

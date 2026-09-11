import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinnedCommand, movePinnedCommand } from "./pinnedCommands";
import { validatePinnedCommands } from "../../../core/src/domain/web-console/pinned-commands";

afterEach(() => vi.unstubAllGlobals());

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

  it("creates distinct persistable commands on HTTP pages without randomUUID", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const first = createPinnedCommand("npm test");
    const second = createPinnedCommand("npm run dev");
    expect(first.id).not.toBe(second.id);
    expect(validatePinnedCommands([first, second])).toEqual([first, second]);
  });
});

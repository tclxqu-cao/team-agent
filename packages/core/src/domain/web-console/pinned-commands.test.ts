import { describe, expect, it } from "vitest";
import { defaultPinnedCommands, parseStoredPinnedCommands, validatePinnedCommands } from "./pinned-commands.js";

describe("pinned commands", () => {
  it("provides the four default launch commands", () => {
    expect(defaultPinnedCommands().map((item) => item.command)).toEqual([
      "codex",
      "claude agents",
      "opencode",
      "agent-tui",
    ]);
  });

  it("preserves an explicitly empty stored list", () => {
    expect(parseStoredPinnedCommands("[]")).toEqual([]);
    expect(parseStoredPinnedCommands(null)).toEqual(defaultPinnedCommands());
  });

  it("accepts shell syntax but rejects multiline and duplicate entries", () => {
    expect(validatePinnedCommands([{ id: "build", command: "npm test && npm run build" }]))
      .toEqual([{ id: "build", command: "npm test && npm run build" }]);
    expect(() => validatePinnedCommands([{ id: "bad", command: "echo one\necho two" }])).toThrow("一行");
    expect(() => validatePinnedCommands([
      { id: "same", command: "codex" },
      { id: "same", command: "opencode" },
    ])).toThrow("不能重复");
  });
});

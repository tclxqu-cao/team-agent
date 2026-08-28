import { describe, expect, it } from "vitest";
import { createSlashItems, parseSlashCommand } from "./commands.js";
import { filterPaletteItems, getActiveTrigger } from "./palette.js";

describe("command palette", () => {
  it("detects slash only at the start and mention at a token boundary", () => {
    expect(getActiveTrigger("/mod", 4)).toEqual({ type: "slash", start: 0, query: "mod" });
    expect(getActiveTrigger("hello /mod", 10)).toBeNull();
    expect(getActiveTrigger("check @src/com", 14)).toEqual({ type: "mention", start: 6, query: "src/com" });
    expect(getActiveTrigger("mail@example", 12)).toBeNull();
  });

  it("groups commands and skills and ranks prefix matches first", () => {
    const items = createSlashItems([{ name: "wiki-query", description: "Search wiki" }]);
    expect(items.some((item) => item.id === "command:/model")).toBe(true);
    expect(items.some((item) => item.id === "skill:wiki-query")).toBe(true);
    expect(filterPaletteItems(items, "mod")[0]?.label).toBe("/model");
  });

  it("intercepts exact built-ins and passes skills or unknown slash input to the agent", () => {
    expect(parseSlashCommand("/model openai/gpt-4o")).toEqual({
      type: "builtin",
      name: "/model",
      args: "openai/gpt-4o",
    });
    expect(parseSlashCommand("/wiki-query latency")).toEqual({ type: "agent", input: "/wiki-query latency" });
    expect(parseSlashCommand("/missing value")).toEqual({ type: "agent", input: "/missing value" });
  });
});

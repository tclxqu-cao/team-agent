import { describe, expect, it } from "vitest";
import { COMPUTER_USE_SKILL, COMPUTER_USE_SKILL_NAME } from "./computer-use-skill.js";

describe("computer-use built-in Skill", () => {
  it("exports stable built-in metadata for the desktop slash picker", () => {
    expect(COMPUTER_USE_SKILL_NAME).toBe("computer-use");
    expect(COMPUTER_USE_SKILL).toMatchObject({
      name: "computer-use",
      source: "custom",
      filePath: "builtin://customer-agent/computer-use",
    });
    expect(COMPUTER_USE_SKILL.description).toContain("macOS desktop");
  });

  it("keeps the single-action Accessibility-first workflow in the prompt", () => {
    expect(COMPUTER_USE_SKILL.prompt).toContain("action=observe");
    expect(COMPUTER_USE_SKILL.prompt).toContain("one desktop action per computer call");
    expect(COMPUTER_USE_SKILL.prompt).toContain("observe again");
    expect(COMPUTER_USE_SKILL.prompt).toContain("stale_observation");
    expect(COMPUTER_USE_SKILL.prompt).toContain("desktop_offline");
    expect(COMPUTER_USE_SKILL.prompt).toContain("If no computer tool is available");
  });
});

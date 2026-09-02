import { describe, expect, it } from "vitest";
import { classifyFileContent } from "./file-types";

describe("classifyFileContent", () => {
  it.each([
    ["app.js", "code"],
    ["theme.css", "style"],
    ["preview.png", "image"],
    ["demo.mp4", "video"],
    ["notes.txt", "text"],
    ["README.md", "markdown"],
    ["package.json", "json"],
    ["data.xlsx", "spreadsheet"],
    ["unknown.bin", "file"],
  ] as const)("classifies %s as %s", (name, expected) => {
    expect(classifyFileContent(name)).toBe(expected);
  });
});

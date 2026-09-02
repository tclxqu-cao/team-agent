import { describe, expect, it } from "vitest";
import {
  ancestorDirectories,
  isPathInsideRoot,
  parentDirectory,
} from "./fileTreeReveal";

describe("file tree reveal paths", () => {
  it("finds the parent directory and removes trailing slashes", () => {
    expect(parentDirectory("/Users/caoqu/project/outputs/report.pdf/")).toBe("/Users/caoqu/project/outputs");
    expect(parentDirectory("/report.pdf")).toBe("/");
  });

  it("checks containment without prefix collisions", () => {
    expect(isPathInsideRoot("/work/project/src/app.ts", "/work/project")).toBe(true);
    expect(isPathInsideRoot("/work/project-old/src/app.ts", "/work/project")).toBe(false);
    expect(isPathInsideRoot("/work/project/src/app.ts", "/")).toBe(true);
  });

  it("returns ancestors from the root through the file parent", () => {
    expect(ancestorDirectories("/work/project", "/work/project/src/features/app.ts")).toEqual([
      "/work/project",
      "/work/project/src",
      "/work/project/src/features",
    ]);
    expect(ancestorDirectories("/work/project", "/work/project/README.md")).toEqual(["/work/project"]);
    expect(ancestorDirectories("/work/project", "/work/other/file.ts")).toEqual([]);
  });
});

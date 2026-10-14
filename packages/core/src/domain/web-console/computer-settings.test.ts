import { describe, expect, it } from "vitest";
import { defaultComputerSettings, validateComputerTools, validateSavedComputerPages } from "./computer-settings";

const page = { id: "docs", name: " 文档 ", url: "https://example.com", openMode: "current" };
describe("computer settings contracts", () => {
  it("defaults to four tools and distinguishes uninitialized pages from an explicit empty list", () => {
    expect(defaultComputerSettings("owner")).toMatchObject({ userId: "owner", revision: 0, visibleTools: ["refresh", "remote", "theme", "files"], savedPages: null });
    expect(validateComputerTools([])).toEqual([]);
    expect(validateSavedComputerPages([])).toEqual([]);
  });
  it("rejects unknown or duplicate tools and gives tools a stable order", () => {
    expect(validateComputerTools(["install", "refresh"])).toEqual(["refresh", "install"]);
    for (const value of [null, {}, ["saved-page"], ["refresh", "refresh"]]) expect(() => validateComputerTools(value)).toThrow();
  });
  it("keeps group creation hidden until enabled and places it immediately after refresh", () => {
    const defaults = defaultComputerSettings("owner").visibleTools;
    expect(defaults).not.toContain("collaboration");
    expect(validateComputerTools([...defaults, "collaboration"])).toEqual([
      "refresh", "collaboration", "remote", "theme", "files",
    ]);
    expect(validateComputerTools(["collaboration"])).toEqual(["collaboration"]);
  });
  it("normalizes pages and whitelists fields", () => {
    expect(validateSavedComputerPages([{ ...page, token: "secret" }])).toEqual([{ id: "docs", name: "文档", url: "https://example.com/", openMode: "current" }]);
  });
  it("rejects unsafe URLs, missing names, duplicate IDs and excessive page lists", () => {
    for (const update of [{ url: "javascript:alert(1)" }, { url: "https://user:pass@example.com" }, { url: "file:///tmp" }, { id: "../a" }, { name: " " }, { name: "a".repeat(61) }, { openMode: "replace" }]) {
      expect(() => validateSavedComputerPages([{ ...page, ...update }])).toThrow();
    }
    expect(() => validateSavedComputerPages([page, page])).toThrow("重复");
    expect(() => validateSavedComputerPages(Array.from({ length: 21 }, (_, index) => ({ ...page, id: String(index) })))).toThrow("20");
  });
});

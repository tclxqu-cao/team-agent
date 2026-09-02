import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProjectBreadcrumbs, getHostEntryIconKind } from "./HostProjectPicker";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./HostProjectPicker.tsx", import.meta.url), "utf8");

describe("HostProjectPicker", () => {
  it("builds root-scoped breadcrumbs", () => {
    expect(buildProjectBreadcrumbs("/", "/Users/caoqu/team-agent")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "caoqu", path: "/Users/caoqu" },
      { label: "team-agent", path: "/Users/caoqu/team-agent" },
    ]);
    expect(buildProjectBreadcrumbs("/Users/caoqu", "/Users/caoqu/team-agent")).toEqual([
      { label: "caoqu", path: "/Users/caoqu" },
      { label: "team-agent", path: "/Users/caoqu/team-agent" },
    ]);
  });

  it("provides complete picker states and commands", () => {
    expect(picker).toContain("正在读取目录");
    expect(picker).toContain("此目录为空");
    expect(picker).toContain("选择此文件夹");
    expect(picker).toContain("关闭目录选择器");
    expect(picker).toContain("createPortal");
  });

  it("maps folders and common file formats to distinct icon kinds", () => {
    expect(getHostEntryIconKind("src", "directory")).toBe("folder");
    expect(getHostEntryIconKind("app.js", "file")).toBe("code");
    expect(getHostEntryIconKind("theme.css", "file")).toBe("style");
    expect(getHostEntryIconKind("preview.png", "file")).toBe("image");
    expect(getHostEntryIconKind("demo.mp4", "file")).toBe("video");
    expect(getHostEntryIconKind("notes.txt", "file")).toBe("text");
    expect(getHostEntryIconKind("README.md", "file")).toBe("markdown");
    expect(getHostEntryIconKind("unknown.bin", "file")).toBe("file");
  });

  it("opens the picker in Web shell instead of rejecting imports", () => {
    expect(app).toContain("setHostProjectPickerOpen(true)");
    expect(app).not.toContain("Web 端无法选择本机项目目录");
  });
});

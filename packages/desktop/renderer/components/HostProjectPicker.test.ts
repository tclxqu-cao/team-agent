import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProjectBreadcrumbs, getHostEntryIconKind, resolveProjectPickerLocation } from "./HostProjectPicker";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./HostProjectPicker.tsx", import.meta.url), "utf8");

describe("HostProjectPicker", () => {
  it("starts directly in the selected project without listing its ancestors", () => {
    expect(resolveProjectPickerLocation(["/Users/caoqu"], ["/Users/caoqu/team-agent/customer-agent", "/Users/caoqu/refund"]))
      .toEqual({ root: "/Users/caoqu", current: "/Users/caoqu/team-agent/customer-agent" });
  });

  it("uses the AgentRoam installation directory when the group has no directory yet", () => {
    expect(resolveProjectPickerLocation(["/Users/caoqu"], [undefined, "/Users/caoqu/.agentroam/"]))
      .toEqual({ root: "/Users/caoqu", current: "/Users/caoqu/.agentroam" });
  });

  it("ignores paths outside the allowed roots and chooses the most specific matching root", () => {
    expect(resolveProjectPickerLocation(["/Users/caoqu", "/Users/caoqu/projects"], ["/etc", "/Users/caoqu/projects/app"]))
      .toEqual({ root: "/Users/caoqu/projects", current: "/Users/caoqu/projects/app" });
    expect(resolveProjectPickerLocation(["/Users/caoqu"], ["/Users/caoqu-other", "/Users/caoqu/../other"]))
      .toEqual({ root: "/Users/caoqu", current: "/Users/caoqu" });
  });

  it("uses the same configured starting point for an empty project picker", () => {
    expect(resolveProjectPickerLocation(["/Users/caoqu"], []))
      .toEqual({ root: "/Users/caoqu", current: "/Users/caoqu" });
    expect(resolveProjectPickerLocation([], ["/Users/caoqu/project"]))
      .toEqual({ root: "", current: "" });
  });

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

import { describe, expect, it } from "vitest";
import { resolveProjectNavigation } from "./project-routing.js";
import type { ProjectCandidate } from "./resources.js";

function project(label: string, searchText: string): ProjectCandidate {
  const projectPath = `/Users/test/${label}`;
  return {
    id: `project:${label}`,
    kind: "project",
    label,
    description: projectPath,
    value: projectPath,
    path: projectPath,
    metadata: { searchText },
  };
}

describe("project navigation", () => {
  it("resolves a Chinese project concept from bounded metadata", () => {
    const result = resolveProjectNavigation("我要进入赔付项目", [
      project("customer-agent", "通用 AI Agent 平台"),
      project("refund", "客服赔付域 赔付申请 赔付审核 赔付工作台"),
    ]);

    expect(result).toMatchObject({ type: "match", project: { label: "refund" } });
  });

  it("prefers an explicitly focused domain over repeated module references", () => {
    const result = resolveProjectNavigation("我要进入赔付项目", [
      project("csc-main", `客服支撑平台 ${"赔付模块 ".repeat(30)}`),
      project("refund", "本仓库当前聚焦客服赔付域"),
    ]);

    expect(result).toMatchObject({ type: "match", project: { label: "refund" } });
  });

  it("returns ambiguous when top candidates have the same confidence", () => {
    const result = resolveProjectNavigation("打开赔付项目", [
      project("refund-one", "赔付"),
      project("refund-two", "赔付"),
    ]);

    expect(result).toMatchObject({ type: "ambiguous", query: "赔付" });
  });

  it("ignores ordinary conversation and unresolved navigation", () => {
    const projects = [project("refund", "客服赔付域")];
    expect(resolveProjectNavigation("赔付项目最近怎么样", projects)).toEqual({ type: "none" });
    expect(resolveProjectNavigation("进入酒店项目", projects)).toEqual({ type: "none" });
  });
});

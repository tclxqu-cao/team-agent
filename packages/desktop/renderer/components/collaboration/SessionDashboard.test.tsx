import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { groupFixture } from "../../../../core/src/domain/collaboration/__tests__/fixtures";
import type { DashboardGroup, SessionDashboardSnapshot } from "../../../../core/src/domain/supervision/types";
const fixture = vi.hoisted(() => ({ snapshot: null as SessionDashboardSnapshot | null, ui: { skin: "pearl", dashboardSessionsMerged: false, setDashboardSessionsMerged: vi.fn() } }));
vi.mock("./useSessionDashboard", () => ({ useSessionDashboard: () => ({ snapshot: fixture.snapshot, loading: false, error: "", refresh: vi.fn() }) }));
vi.mock("../../stores/uiStore", () => ({ useUIStore: (selector: (state: typeof fixture.ui) => unknown) => selector(fixture.ui) }));
import SessionDashboard from "./SessionDashboard";
import MonitoredSessionPicker, { mergeCatalogPage } from "./MonitoredSessionPicker";

beforeEach(() => { fixture.snapshot = null; fixture.ui.dashboardSessionsMerged = false; });

it("keeps Dashboard, group management, Agent navigation and source-linked group decisions separate", () => {
  const group: DashboardGroup = { group: groupFixture(), status: "waiting", updated: "2026-10-28", progress: "等待业务选择", runningCount: 1, decisionCount: 1, discussionId: "older-active", questions: [{ discussionId: "older-active", questionId: "q", text: "是否选择方案 A", options: [{ label: "A", description: "成本低" }] }], sessions: [{ id: "codex:internal", agentType: "codex", cwd: "/project", title: "群内会话" }] };
  fixture.snapshot = { groupTotal: 12, groups: [group], agents: [{ agentType: "codex", sessions: [{ id: "codex:original", title: "原始任务", agentType: "codex", cwd: "/project", status: "running", updated: "2026-10-28", canResume: true }] }], updatedAt: "2026-10-28" };
  const html = renderToStaticMarkup(createElement(SessionDashboard));
  expect(html).toContain("Dashboard"); expect(html).toContain("群聊列表"); expect(html).toContain("Top 10");
  expect(html).toContain("群内会话"); expect(html).toContain("原始任务"); expect(html).toContain("查看来源会话");
  expect(html).toContain("是否选择方案 A"); expect(html).toContain("查看全部");
  expect(html).toContain("合并会话"); expect(html).toContain('aria-pressed="false"');
});

it("merges group chats and running sessions, prioritizing decisions and preserving group actions", () => {
  fixture.ui.dashboardSessionsMerged = true;
  const group: DashboardGroup = { group: groupFixture(), status: "running", updated: "2026-10-28T10:30:00Z", progress: "继续验证", runningCount: 1, decisionCount: 0, questions: [], sessions: [] };
  fixture.snapshot = { groupTotal: 3, groups: [
    { ...group, group: { ...group.group, id: "idle", name: "空闲群聊" }, status: "idle", runningCount: 0, updated: "2026-10-28T12:00:00Z" },
    { ...group, group: { ...group.group, id: "waiting", name: "待决策群聊" }, status: "waiting", decisionCount: 1, updated: "2026-10-28T09:00:00Z", questions: [{ discussionId: "discussion", questionId: "question", text: "请选择交付方案" }] },
    { ...group, group: { ...group.group, id: "running", name: "运行群聊" } },
  ], updatedAt: "2026-10-28", agents: [
    { agentType: "codex", sessions: [{ id: "codex:older", agentType: "codex", title: "较早的 Codex 任务", cwd: "/codex-project", status: "running", updated: "2026-10-28T10:00:00Z", canResume: true }] },
    { agentType: "claude-code", sessions: [{ id: "claude:newer", agentType: "claude-code", title: "较新的 Claude 任务", cwd: "/claude-project", status: "running", updated: "2026-10-28T11:00:00Z", canResume: true }] },
    { agentType: "customer-agent", sessions: [] },
  ] };
  const html = renderToStaticMarkup(createElement(SessionDashboard));
  expect(html).toContain("按 Agent 分组"); expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="合并会话"');
  expect(html).not.toContain('aria-label="群聊运行总览"');
  expect(html).not.toContain("Top 10");
  expect(html).not.toContain('aria-label="Codex 运行会话"');
  expect(html).not.toContain('aria-label="Claude Code 运行会话"');
  expect(html).not.toContain('aria-label="Customer Agent 运行会话"');
  expect(html.indexOf("较新的 Claude 任务")).toBeLessThan(html.indexOf("较早的 Codex 任务"));
  expect(html.indexOf("待决策群聊")).toBeLessThan(html.indexOf("较新的 Claude 任务"));
  expect(html.indexOf("较新的 Claude 任务")).toBeLessThan(html.indexOf("运行群聊"));
  expect(html.indexOf("运行群聊")).toBeLessThan(html.indexOf("较早的 Codex 任务"));
  expect(html.indexOf("较早的 Codex 任务")).toBeLessThan(html.indexOf("空闲群聊"));
  expect(html).toContain("请选择交付方案"); expect(html).toContain("查看来源会话"); expect(html).toContain("进入群聊");
  expect(html).toContain('data-agent-icon="codex"'); expect(html).toContain('data-agent-icon="claude-code"');
  expect(html).toContain('role="img" aria-label="Codex"'); expect(html).toContain('role="img" aria-label="Claude Code"');
  expect(html).toContain("/codex-project"); expect(html).toContain("/claude-project");
  expect(html).not.toContain("查看全部");
  expect(html).not.toContain("当前没有运行中的会话");
});

it("keeps empty dashboards compact in both display modes", () => {
  fixture.ui.dashboardSessionsMerged = true;
  fixture.snapshot = { groupTotal: 0, groups: [], updatedAt: "2026-10-28", agents: [{ agentType: "codex", sessions: [] }, { agentType: "customer-agent", sessions: [] }] };
  const html = renderToStaticMarkup(createElement(SessionDashboard));
  expect(html.match(/当前没有运行中的会话/g)).toHaveLength(1);
  expect(html).not.toContain('aria-label="群聊运行总览"');
  expect(html).not.toContain("还没有群聊");
  fixture.ui.dashboardSessionsMerged = false;
  const grouped = renderToStaticMarkup(createElement(SessionDashboard));
  expect(grouped).toContain("创建群聊，配置监工");
  expect(grouped).not.toContain("还没有群聊");
  expect(grouped).not.toContain("Top 10");
  expect(grouped).not.toContain('aria-label="群聊运行总览"');
});

it("retains selected sessions independently of result pages and deduplicates appended rows", () => {
  const selected = { id: "codex:selected", agentType: "codex" as const, title: "跨页选择保留", cwd: "/project" };
  const html = renderToStaticMarkup(createElement(MonitoredSessionPicker, { value: [selected], onChange: vi.fn() }));
  expect(html).toContain("跨页选择保留"); expect(html).toContain("已选 1"); expect(html).toContain("搜索所有原始会话");
  const row = { ...selected, updated: "2026-10-28", status: "running" as const, canResume: true };
  expect(mergeCatalogPage([row], [row, { ...row, id: "other" }])).toHaveLength(2);
});

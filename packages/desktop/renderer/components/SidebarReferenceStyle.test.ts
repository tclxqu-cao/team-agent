import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
const uiStore = readFileSync(new URL("../stores/uiStore.ts", import.meta.url), "utf8");

describe("AgentRoam reference sidebar", () => {
  it("keeps the requested brand, project toolbar, and hierarchy", () => {
    expect(app).toContain('className="sidebar-brand-name">AgentRoam');
    expect(app).toContain('className="sidebar-project-title">项目');
    expect(app).toContain('aria-label="搜索会话"');
    expect(app).toContain('className="sidebar-agent-group"');
    expect(app).toContain('className={`sidebar-row sidebar-session-row');
  });

  it("gives the project section more vertical breathing room", () => {
    expect(css).toContain("margin: 8px 14px 8px");
    expect(css).toContain("margin-bottom: 7px");
  });

  it("keeps redundant brand actions out of the sidebar", () => {
    expect(app).not.toContain('className="sidebar-search-trigger"');
    expect(app).not.toContain("会话 · {allVisibleSessions.length}");
    expect(app).not.toContain('className="app-sidebar-section"');
    expect(app).not.toContain('className="ui-icon-button sidebar-brand-action"');
  });

  it("overlays the resize hit area without creating a visible layout gutter", () => {
    const start = app.indexOf('className={`app-sidebar-resizer');
    const end = app.indexOf("{searchOpen && (", start);
    const resizer = app.slice(start, end);
    const cssStart = css.indexOf(".app-sidebar-resizer {");
    const cssEnd = css.indexOf("/* ── AgentRoam conversation drawer ── */", cssStart);
    const resizerCss = css.slice(cssStart, cssEnd);

    expect(start).toBeGreaterThan(-1);
    expect(resizer).toContain("left: sidebarWidth");
    expect(resizer).not.toContain("width: 4");
    expect(resizerCss).toContain("width: 8px");
    expect(resizerCss).toContain(".app-sidebar-resizer::after");
    expect(resizerCss).toContain("width: 1px");
    expect(resizerCss).toContain("background: var(--accent)");
  });

  it("orders search, grouping, collapse, sorting, and project import in one toolbar", () => {
    const toolbar = app.slice(
      app.indexOf('className="sidebar-project-toolbar"'),
      app.indexOf("{notice && ("),
    );
    const search = toolbar.indexOf('aria-label="搜索会话"');
    const grouping = toolbar.indexOf('aria-label="会话按 Agent 分组"');
    const collapse = toolbar.indexOf('aria-label={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}');
    const sorting = toolbar.indexOf('aria-label={runningFirst ? "按新建时间排序" : "进行中会话优先"}');
    const importProject = toolbar.indexOf('aria-label="导入项目"');
    expect(search).toBeGreaterThan(-1);
    expect(grouping).toBeGreaterThan(search);
    expect(collapse).toBeGreaterThan(grouping);
    expect(sorting).toBeGreaterThan(collapse);
    expect(importProject).toBeGreaterThan(sorting);
    expect(toolbar).toContain("aria-pressed={runningFirst}");
    expect(toolbar).not.toContain("{!webShell &&");
  });

  it("shows only project sessions and reveals project creation actions on demand", () => {
    expect(app).toContain("const allVisibleSessions = Object.values(sessionsByProject).flat()");
    expect(app).not.toContain("其他本机会话");
    expect(css).toContain('.sidebar-project-add-action[aria-expanded="true"]');
    expect(css).toContain(".sidebar-row:hover .sidebar-row-action");
  });

  it("loads project sessions on demand with a persistent stale-while-revalidate cache", () => {
    const bootstrap = app.slice(app.indexOf("useEffect(() => {"), app.indexOf("// Sync working directory"));
    expect(bootstrap).toContain("void loadProjects()");
    expect(bootstrap).not.toContain("listSessions()");
    expect(app).toContain('const SESSION_INDEX_CACHE_KEY = "agentroam.session-index.v1"');
    expect(app).toContain("buildCachedSessionState(readSessionIndexCache())");
    expect(app).toContain("const cachedProjectIds = new Set(");
    expect(app).toContain("invalid.has(projectId) || loadingProjectIdsRef.current.has(projectId)");
    expect(app).toContain("void loadSessions(projectId, { refresh: true, background: true })");
    expect(app).toContain("void loadSessions(projectId, { refresh: hasCache, background: hasCache })");
    expect(app).toContain("loadSessions(selectedProjectId, { refresh: true, background: true })");
    expect(app).toContain("正在加载会话...");
    expect(app).toContain("会话加载失败");
  });

  it("collapses and expands the complete project and session hierarchy", () => {
    expect(app).toContain("const handleCollapseAllSessions = () =>");
    expect(app).toContain("setExpandedProjects(new Set())");
    expect(app).toContain("setCollapsedBotGroups(new Set(botGroupKeysInOrder()))");
    expect(app).toContain("setCollapsedParents(new Set(Object.keys(childSessionsByParent)))");
    expect(app).toContain("const handleExpandAllSessions = () =>");
    expect(app).toContain("setCollapsedBotGroups(new Set())");
    expect(app).toContain("setCollapsedParents(new Set())");
    expect(app).toContain('title={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}');
    expect(app).toContain("disabled={collapsibleProjectIds.length === 0}");
    expect(app).toContain("aria-expanded={isExpanded}");
    expect(app).toContain('d="m17 11-5-5-5 5"');
    expect(app).toContain('d="m7 13 5 5 5-5"');
    expect(app).not.toContain('["全部折叠", handleCollapseAllBotGroups');
    expect(app).not.toContain('["逐层展开", handleExpandNextBotGroup');
    expect(app).not.toContain('["全部展开", handleExpandAllBotGroups');
  });

  it("shows counts only in grouped mode and hides redundant runtime marks", () => {
    expect(app).toContain('className={`sidebar-project-sessions${groupByBot ? " is-grouped" : ""}`}');
    expect(app).toContain("projSessions.length > 0 && groupByBot");
    expect(app).toContain("children.length > 0 && groupByBot");
    expect(app).toContain("!groupByBot && (");
    expect(css).toContain(".sidebar-project-sessions.is-grouped .sidebar-session-row");
    expect(css).toContain("padding-left: 28px");
  });

  it("places the delete icon between the session title and runtime mark", () => {
    const sessionButton = app.indexOf('className="sidebar-session-button"');
    const deleteButton = app.indexOf('className="sidebar-session-delete sidebar-row-action', sessionButton);
    const runtimeMark = app.indexOf("sidebar-runtime-mark--${session.agentType}", deleteButton);
    expect(deleteButton).toBeGreaterThan(-1);
    expect(deleteButton).toBeGreaterThan(sessionButton);
    expect(runtimeMark).toBeGreaterThan(deleteButton);
    expect(app).toContain("<SidebarDeleteIcon />");
    expect(css).toContain(".sidebar-session-delete");
    expect(css).toContain(".sidebar-session-row > .sidebar-runtime-mark");
  });

  it("keeps project deletion on desktop only and uses the shared trash icon", () => {
    const projectDeleteStart = app.indexOf("{/* Delete project button */}");
    const projectDeleteEnd = app.indexOf("<RuntimeSessionMenu", projectDeleteStart);
    const projectDeleteButton = app.slice(projectDeleteStart, projectDeleteEnd);

    expect(projectDeleteStart).toBeGreaterThan(-1);
    expect(projectDeleteButton).toContain("{!webShell && (");
    expect(projectDeleteButton).toContain('aria-label={`删除项目：${project.name}`}');
    expect(projectDeleteButton).toContain("sidebar-project-delete");
    expect(projectDeleteButton).toContain("<SidebarDeleteIcon />");
    expect(projectDeleteButton).not.toContain(">×</button>");
    expect(css).toContain(".sidebar-project-row .sidebar-row-action {");
    expect(css).toContain(".sidebar-project-row .sidebar-project-delete svg {");
  });

  it("shows runtime, external occupancy, and semantic status markers in detail mode", () => {
    expect(app).toContain("sidebar-runtime-mark--${session.agentType}");
    expect(app).toContain('title="原客户端正在使用，只读">占用</span>');
    expect(app).not.toContain(">外部占用</span>");
    expect(app).toContain("message.askUser && !message.askUser.answered");
    expect(app).toContain("getSidebarSessionVisualState");
    expect(app).toContain('className={`sidebar-status-dot is-${visualState}`}');
    expect(css).toContain(".sidebar-status-dot.is-needs-input");
    expect(css).toContain(".sidebar-status-dot.is-running");
    expect(css).toContain(".sidebar-status-dot.is-completed");
    expect(css).toContain(".sidebar-status-dot.is-error");
    expect(css).toContain("@keyframes sidebarStatusBlink");
    expect(css).toContain("--sidebar-status-color: var(--danger)");
    expect(css).toContain("--sidebar-status-color: var(--success)");
    expect(css).toContain("--sidebar-status-color: var(--accent)");
    expect(css).toContain("--sidebar-status-color: var(--status-error)");
    expect(css).not.toContain(".sidebar-status-dot.is-selected");
  });

  it("keeps disclosure chevrons in message history and out of project rows", () => {
    const projectButton = app.slice(
      app.indexOf('className="sidebar-project-button"'),
      app.indexOf("{/* Delete project button */"),
    );
    expect(projectButton).not.toContain("sidebar-tree-disclosure");
    expect(projectButton).not.toContain('d="m9 18 6-6-6-6"');
    expect(projectButton).toContain('d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20');
    expect(projectButton).toContain('d="M22 19a2 2 0 0 1-2 2H4');
    expect(app).toContain('className="sidebar-agent-group"');
    expect(app).toContain("sidebar-session-disclosure");
    expect(app).toContain('d="m9 18 6-6-6-6"');
    expect(app).not.toContain('<line x1="9" y1="14" x2="15" y2="14"/>');
    expect(css).toContain(".sidebar-session-disclosure.is-expanded");
  });

  it("derives sidebar colors from the active skin and migrates grouped view on", () => {
    const start = css.indexOf("/* ── AgentRoam conversation drawer ── */");
    const end = css.indexOf("/* ── Settings and appearance ── */", start);
    const sidebarCss = css.slice(start, end);
    expect(sidebarCss).toContain("var(--bg-surface)");
    expect(sidebarCss).toContain("var(--accent)");
    expect(sidebarCss).toContain("var(--info)");
    expect(sidebarCss).toContain("var(--warning)");
    expect(sidebarCss).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(uiStore).toContain("groupByBot: true");
    expect(uiStore).toContain("version: UI_PREFERENCES_VERSION");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
const uiStore = readFileSync(new URL("../stores/uiStore.ts", import.meta.url), "utf8");
const sessionRow = readFileSync(new URL("./SidebarSessionRow.tsx", import.meta.url), "utf8");
const deleteConfirmation = readFileSync(new URL("./SidebarDeleteConfirmation.tsx", import.meta.url), "utf8");
const sessionDeletion = readFileSync(new URL("../lib/session-deletion.ts", import.meta.url), "utf8");

describe("AgentRoam reference sidebar", () => {
  it("keeps the requested brand, Agent switcher, directory toolbar, and hierarchy", () => {
    expect(app).toContain('className="sidebar-brand-name">AgentRoam');
    expect(app).toContain("<AgentWorkspaceSwitcher");
    expect(app).toContain('className="sidebar-project-title">目录');
    expect(app).toContain('aria-label="搜索会话"');
    expect(app).not.toContain('className="sidebar-agent-group"');
    expect(app).toContain("<SidebarSessionRow");
    expect(app).toContain('className="sidebar-new-session-primary"');
    expect(css).toContain("grid-template-columns: repeat(4, minmax(38px, 1fr))");
    expect(css).toContain(".agent-workspace-switcher button.is-active");
    expect(css).toContain("border-color: transparent");
  });

  it("gives the project section more vertical breathing room", () => {
    expect(css).toContain("margin: 6px 14px 6px");
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

  it("places search before the directory toolbar and preserves toolbar action order", () => {
    const search = app.indexOf('className="sidebar-search-field"');
    const toolbarStart = app.indexOf('className="sidebar-project-toolbar"');
    const toolbar = app.slice(
      toolbarStart,
      app.indexOf("{/* Project + session list */}"),
    );
    const collapse = toolbar.indexOf('aria-label={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}');
    const sorting = toolbar.indexOf('aria-label={runningFirst ? "按新建时间排序" : "进行中会话优先"}');
    const importProject = toolbar.indexOf('aria-label="导入目录"');
    expect(search).toBeGreaterThan(-1);
    expect(search).toBeLessThan(toolbarStart);
    expect(toolbar).not.toContain("会话按 Agent 分组");
    expect(collapse).toBeGreaterThan(-1);
    expect(sorting).toBeGreaterThan(collapse);
    expect(importProject).toBeGreaterThan(sorting);
    expect(toolbar).toContain("aria-pressed={runningFirst}");
    expect(toolbar).toContain("aria-pressed={allProjectsCollapsed}");
    expect(toolbar).toContain('sidebar-collapse-all${allProjectsCollapsed ? " is-active" : ""}');
    expect(toolbar).not.toContain('activeAgent === "customer-agent"');
    expect(app).toContain("window.agentApi.importAgentWorkspace(");
    expect(app).toContain('"该文件夹已在当前 Agent 的目录中"');
  });

  it("keeps session selection stable across repeated clicks and project disclosure", () => {
    expect(app).toContain("applySidebarSelection(selectProject(projectId))");
    expect(app).toContain("applySidebarSelection(selectSession(project.id, session.id))");
    expect(app).toContain("applySidebarSelection(selectSession(project.id, child.id))");
    expect(app).not.toContain("toggleProjectSelection(");
    expect(app).not.toContain("toggleSessionSelection(");
    expect(app).not.toContain("const nextSelection = active");
    expect(app).toContain("aria-pressed={isSelected}");
    expect(app).toContain("active: isActiveSession");
    expect(app).toContain("active: selectedSessionId === child.id");
    expect(sessionRow).toContain("aria-pressed={session.active}");
  });

  it("shows Codex compatibility state in every sidebar session path", () => {
    expect(app.match(/compatibility: session\.compatibility/g)).toHaveLength(2);
    expect(app).toContain("compatibility: child.compatibility");
    expect(sessionRow).toContain('session.compatibility?.status === "checking"');
    expect(sessionRow).toContain('session.compatibility?.status === "incompatible"');
    expect(sessionRow).toContain('aria-label="Codex 版本不兼容"');
  });

  it("keeps the active project highlighted while viewing one of its sessions", () => {
    expect(app).toContain("const isSelected = selectedProjectId === project.id;");
    expect(app).not.toContain("selectedProjectId === project.id && !selectedSessionId");
  });

  it("uses a flat search affordance and avoids sticky touch hover states", () => {
    const searchStart = css.indexOf(".sidebar-search-field {");
    const searchEnd = css.indexOf(".sidebar-project-toolbar", searchStart);
    const searchCss = css.slice(searchStart, searchEnd);
    expect(searchCss).toContain("border: 1px solid transparent");
    expect(searchCss).toContain("background: transparent");
    expect(searchCss).toContain(".sidebar-search-field kbd");
    expect(searchCss).toContain("border: 0");
    expect(css).toContain("@media (hover: hover) and (pointer: fine)");
  });

  it("does not retain mouse-focus highlighting after toolbar toggles are cleared", () => {
    expect(css).not.toContain(".sidebar-row:hover,\n.sidebar-row:focus-within {");
    expect(css).not.toContain(".sidebar-row:focus-within .sidebar-row-action");
    expect(css).not.toContain(".sidebar-row:has(button:focus-visible)");
    expect(css).toContain(".sidebar-row-action:focus-visible");
    expect(app).not.toContain("groupByBot");
    expect(app).toContain("blurDeactivatedPointerToggle(event, allProjectsCollapsed)");
    expect(app).toContain("blurDeactivatedPointerToggle(event, runningFirst)");
  });

  it("releases the message input before project and session pointer actions", () => {
    expect(app).toContain("function blurActiveTextEntry(): void");
    expect(app).toContain('activeElement.matches("input, textarea, select")');
    expect(app).toContain("onPointerDownCapture={blurActiveTextEntry}");
  });

  it("shows only the active Agent's workspace sessions and reveals row actions on demand", () => {
    expect(app).toContain("...Object.values(sessionsByProject).flat()");
    expect(app).toContain("...Object.values(childSessionsByParent).flat()");
    expect(app).not.toContain("其他本机会话");
    expect(css).toContain('.sidebar-project-add-action[aria-expanded="true"]');
    expect(css).toContain(".sidebar-row:hover .sidebar-row-action");
  });

  it("loads workspace sessions on demand with an Agent-partitioned stale-while-revalidate cache", () => {
    const bootstrap = app.slice(app.indexOf("useEffect(() => {"), app.indexOf("// Sync working directory"));
    expect(bootstrap).toContain("void loadProjects(activeAgentRef.current");
    expect(bootstrap).not.toContain("listSessions()");
    expect(app).toContain("const [initialWorkspaceCache] = useState(readAgentWorkspaceCache)");
    expect(app).toContain("writeAgentWorkspaceCache(cache)");
    expect(sessionDeletion).toContain("确定归档 Codex 会话");
    expect(app).toContain("workspaceCacheRef.current.agents[agentType]");
    expect(app).toContain("sidebarScrollTop: sidebarScrollRef.current?.scrollTop");
    expect(app).toContain("const activeSessionId = selectedSessionIdRef.current");
    expect(app).toContain("const activeProjectId = selectedProjectIdRef.current");
    expect(app).toContain("const cachedProjectIds = new Set(");
    expect(app).toContain("cachedProjectIds.add(restoredProjectId)");
    expect(app).toContain("invalid.has(projectId) || loadingProjectIdsRef.current.has(projectId)");
    expect(app).toContain("void loadSessions(projectId, { refresh: true, background: true })");
    expect(app).toContain("void loadSessions(projectId, { refresh: hasCache, background: hasCache })");
    expect(app).toContain("loadSessions(selectedProjectId, { refresh: true, background: true })");
    expect(app).toContain("正在加载会话...");
    expect(app).toContain("会话加载失败");
    expect(app).toContain("workspaceNextCursor && !workspaceLoading");
    expect(app).toContain("nextCursor && !isProjectLoading");
    expect(app).toContain("limit: 20");
    expect(app).toContain("project.canCreateSession === false");
    expect(app).toContain("<History size={13}");
    expect(app).toContain("project.canCreateSession !== false && (");
  });

  it("collapses and expands the complete project and session hierarchy", () => {
    expect(app).toContain("const handleCollapseAllSessions = () =>");
    expect(app).toContain("setExpandedProjects(new Set())");
    expect(app).toContain("setCollapsedParents(new Set(Object.keys(childSessionsByParent)))");
    expect(app).toContain("const handleExpandAllSessions = () =>");
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

  it("removes Agent grouping and redundant runtime marks from the workspace tree", () => {
    expect(app).toContain('className="sidebar-project-sessions"');
    expect(app).not.toContain("groupByBot");
    expect(app).not.toContain("sidebar-agent-group");
    expect(app).not.toContain("sidebar-runtime-mark");
    expect(css).not.toContain("sidebar-project-sessions.is-grouped");
    expect(css).not.toContain(".sidebar-agent-group");
  });

  it("keeps session deletion beside the session title", () => {
    const sessionButton = sessionRow.indexOf('className="sidebar-session-button"');
    const deleteButton = sessionRow.indexOf('className="sidebar-session-delete sidebar-row-action', sessionButton);
    expect(deleteButton).toBeGreaterThan(-1);
    expect(deleteButton).toBeGreaterThan(sessionButton);
    expect(sessionRow).toContain("<Trash2");
    expect(app).not.toContain("window.confirm(");
    expect(app).toContain("sessionDeletionConfirmation(sessionDeleteRequest.session)");
    expect(app).toContain("const confirmDeleteSession = async () =>");
    expect(app).toContain("removeSessionFromCollections(");
    expect(app).toContain("removeSessionIdsFromWorkspacePartition(partition, removal.removedIds)");
    expect(app).toContain("sessionsByProjectRef.current");
    expect(app).toContain("childSessionsByParentRef.current");
    expect(app).toContain("projectSessionRequestIds.current.set(");
    expect(app).toContain("writeAgentWorkspaceCache(cache)");
    expect(app).toContain("requestDeleteSession(session, anchor)");
    expect(app).toContain("requestDeleteSession(child, anchor)");
    expect(app).toContain("<SidebarDeleteConfirmation");
    expect(deleteConfirmation).toContain('role="alertdialog"');
    expect(css).toContain(".sidebar-session-delete");
    expect(css).not.toContain(".sidebar-session-row > .sidebar-runtime-mark");
  });

  it("keeps project deletion on desktop only and uses the shared trash icon", () => {
    const projectDeleteStart = app.indexOf('{activeAgent === "customer-agent" && !webShell && (');
    const projectDeleteEnd = app.indexOf('className="sidebar-runtime-create', projectDeleteStart);
    const projectDeleteButton = app.slice(projectDeleteStart, projectDeleteEnd);

    expect(projectDeleteStart).toBeGreaterThan(-1);
    expect(projectDeleteButton).toContain('activeAgent === "customer-agent"');
    expect(projectDeleteButton).toContain('aria-label={`删除目录：${project.name}`}');
    expect(projectDeleteButton).toContain("sidebar-project-delete");
    expect(projectDeleteButton).toContain("<SidebarDeleteIcon />");
    expect(projectDeleteButton).not.toContain(">×</button>");
    expect(css).toContain(".sidebar-project-row .sidebar-row-action {");
    expect(css).toContain(".sidebar-project-row .sidebar-project-delete svg {");
  });

  it("shows external occupancy and semantic status markers in detail mode", () => {
    expect(app).not.toContain("sidebar-runtime-mark--${session.agentType}");
    expect(sessionRow).toContain("<LockKeyhole");
    expect(sessionRow).toContain('aria-label="原客户端正在使用，只读"');
    expect(sessionRow).not.toContain(">占用</span>");
    expect(app).not.toContain(">外部占用</span>");
    expect(app).toContain("message.askUser && !message.askUser.answered");
    expect(app).toContain("getSidebarSessionVisualState");
    expect(sessionRow).toContain('className={`sidebar-status-dot is-${session.visualState}`}');
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
      app.indexOf('{activeAgent === "customer-agent" && !webShell && ('),
    );
    expect(projectButton).not.toContain("sidebar-tree-disclosure");
    expect(projectButton).not.toContain('d="m9 18 6-6-6-6"');
    expect(projectButton).toContain('d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20');
    expect(projectButton).toContain('d="M22 19a2 2 0 0 1-2 2H4');
    expect(app).not.toContain('className="sidebar-agent-group"');
    expect(sessionRow).toContain("sidebar-session-disclosure");
    expect(sessionRow).toContain("<ChevronRight");
    expect(app).not.toContain('<line x1="9" y1="14" x2="15" y2="14"/>');
    expect(css).toContain(".sidebar-session-disclosure.is-expanded");
  });

  it("derives sidebar colors from the active skin and removes the grouped preference", () => {
    const start = css.indexOf("/* ── AgentRoam conversation drawer ── */");
    const end = css.indexOf("/* ── Settings and appearance ── */", start);
    const sidebarCss = css.slice(start, end);
    expect(sidebarCss).toContain("var(--bg-surface)");
    expect(sidebarCss).toContain("var(--accent)");
    expect(sidebarCss).toContain("var(--warning)");
    expect(sidebarCss).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(uiStore).not.toContain("groupByBot");
    expect(uiStore).toContain("UI_PREFERENCES_VERSION = 3");
    expect(uiStore).toContain("version: UI_PREFERENCES_VERSION");
  });

  it("keeps directory paths and session metadata out of the visible rows", () => {
    const projectButton = app.slice(
      app.indexOf('className="sidebar-project-button"'),
      app.indexOf('{activeAgent === "customer-agent"'),
    );
    expect(projectButton).toContain("{project.name}");
    expect(projectButton).toContain("project.description}");
    expect(projectButton).not.toContain(">{project.description}<");
    expect(app).not.toContain("sidebar-project-session-count");
    expect(app).not.toContain("projectSessions.length} 个会话");
    expect(sessionRow).not.toContain("sourceLabel");
    expect(sessionRow).not.toContain("created");
    expect(sessionRow).not.toContain("updated");
    expect(sessionRow).not.toContain("messageCount");
    expect(sessionRow).not.toContain("sidebar-session-meta");
  });

  it("keeps the bottom action scoped to the selected directory", () => {
    const buttonStart = app.indexOf('className="sidebar-new-session-primary"');
    const buttonEnd = app.indexOf("</button>", buttonStart);
    const button = app.slice(buttonStart, buttonEnd);
    expect(button).toContain("projects.find((project) => project.id === selectedProjectId)?.canCreateSession !== false");
    expect(button).toContain("projects.find((project) => project.id === selectedProjectId)?.canCreateSession === false");
    expect(app).toContain('setNotice("请先选择目录")');
    expect(app).toContain('setNoticeType("info")');
    expect(button).toContain('onClick={handleBottomNewSession}');
    expect(button).toContain("disabled={\n              sessionCreationPending !== null");
    expect(button).toContain("|| (selectedProjectId !== null && invalidProjectIds.has(selectedProjectId))");
    expect(app).toContain("handleNewRuntimeSession(selectedProjectId, activeAgent)");
    expect(app).toContain('workspace?.source === "imported" ? undefined : projectId');
    expect(css).toContain(".sidebar-bottom-action");
    expect(css).toContain(".sidebar-new-session-primary:disabled");
    const buttonCssStart = css.indexOf(".sidebar-new-session-primary {");
    const buttonCssEnd = css.indexOf(".sidebar-delete-confirmation-layer", buttonCssStart);
    const buttonCss = css.slice(buttonCssStart, buttonCssEnd);
    expect(buttonCss.match(/background: color-mix\(in srgb, var\(--accent\) 88%, var\(--text-primary\)\);/g))
      .toHaveLength(2);
  });

  it("shows stable loading feedback while a new session is being created", () => {
    const projectActionClass = app.indexOf('className="sidebar-runtime-create sidebar-project-add-action');
    const projectActionStart = app.lastIndexOf("<button", projectActionClass);
    const projectActionEnd = app.indexOf("</button>", projectActionClass);
    const projectAction = app.slice(projectActionStart, projectActionEnd);
    const bottomActionStart = app.indexOf('className="sidebar-new-session-primary"');
    const bottomActionEnd = app.indexOf("</button>", bottomActionStart);
    const bottomAction = app.slice(bottomActionStart, bottomActionEnd);

    expect(app).toContain('import { History, LoaderCircle, Plus, Search } from "lucide-react"');
    expect(app).toContain("const [sessionCreationPending, setSessionCreationPending]");
    expect(app).toContain("const isCreatingSession = sessionCreationPending?.agentType === activeAgent");
    expect(projectAction).toContain('aria-busy={isCreatingSession}');
    expect(projectAction).toContain('sessionCreationPending !== null');
    expect(projectAction).toContain('<LoaderCircle size={13}');
    expect(projectAction).toContain('"正在创建会话"');
    expect(bottomAction).toContain('aria-busy={sessionCreationPending !== null}');
    expect(bottomAction).toContain('sessionCreationPending !== null');
    expect(bottomAction).toContain('<LoaderCircle size={16}');
    expect(bottomAction).toContain("正在创建...");
  });

  it("guards and cleans up the new-session creation lifecycle", () => {
    const handlerStart = app.indexOf("const handleNewRuntimeSession = async");
    const handlerEnd = app.indexOf("const handleBottomNewSession", handlerStart);
    const handler = app.slice(handlerStart, handlerEnd);
    const selection = handler.indexOf("applySidebarSelection({ projectId, sessionId: created.id })");
    const backgroundRefresh = handler.indexOf("void loadSessions(projectId, {");

    expect(handler).toContain("if (sessionCreationPendingRef.current) return");
    expect(handler).toContain("sessionCreationPendingRef.current = true");
    expect(handler).toContain("setSessionCreationPending({ projectId, agentType })");
    expect(handler).toContain("try {");
    expect(handler).toContain("} catch (error) {");
    expect(handler).toContain('error instanceof Error ? error.message : "新建会话失败"');
    expect(handler).toContain("} finally {");
    expect(handler).toContain("sessionCreationPendingRef.current = false");
    expect(handler).toContain("setSessionCreationPending(null)");
    expect(handler).toContain("sessionsByProjectRef.current = nextSessionsByProject");
    expect(selection).toBeGreaterThan(-1);
    expect(backgroundRefresh).toBeGreaterThan(selection);
    expect(handler).not.toContain("await loadSessions(projectId)");
  });

  it("renders sidebar action feedback as a page-level portal without shifting the list", () => {
    const sidebarStart = app.indexOf('<aside\n        className="app-sidebar"');
    const sidebarEnd = app.indexOf("</aside>", sidebarStart);
    const notice = app.indexOf("{notice && createPortal(");
    expect(notice).toBeGreaterThan(sidebarEnd);
    expect(app).toContain('className={`app-action-notice is-${noticeType}`}');
    expect(css).toContain("position: fixed");
    expect(css).toContain(".app-action-notice.is-success");
    expect(css).toContain(".app-action-notice.is-error");
  });
});

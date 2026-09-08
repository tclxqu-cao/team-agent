import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SidebarSessionRow from "./SidebarSessionRow";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const rowSource = readFileSync(new URL("./SidebarSessionRow.tsx", import.meta.url), "utf8");

describe("SidebarSessionRow", () => {
  it("renders one compact line with the status before the title and an accessible lock", () => {
    const html = renderToStaticMarkup(createElement(SidebarSessionRow, {
      session: {
        id: "session-1",
        title: "Review the workspace",
        visualState: "running",
        statusLabel: "进行中",
        occupiedExternally: true,
        canDelete: false,
        active: true,
      },
      onSelect: () => undefined,
    }));

    expect(html.indexOf("sidebar-status-dot")).toBeLessThan(html.indexOf("sidebar-session-title"));
    expect(html).toContain('class="sidebar-session-title"');
    expect(html).toContain('aria-label="原客户端正在使用，只读"');
    expect(html).toContain("lucide-lock-keyhole");
    expect(html).not.toContain("sourceLabel");
    expect(html).not.toContain("sidebar-session-meta");
  });

  it("keeps child indentation and parent disclosure as stable row states", () => {
    const child = renderToStaticMarkup(createElement(SidebarSessionRow, {
      session: {
        id: "child-1",
        title: "Child session",
        visualState: "completed",
        statusLabel: "已完成",
        occupiedExternally: false,
        canDelete: true,
        active: false,
        child: true,
      },
      onSelect: () => undefined,
      onDelete: () => undefined,
    }));
    const parent = renderToStaticMarkup(createElement(SidebarSessionRow, {
      session: {
        id: "parent-1",
        title: "Parent session",
        visualState: "completed",
        statusLabel: "已完成",
        occupiedExternally: false,
        canDelete: false,
        active: false,
        hasChildren: true,
        expanded: true,
      },
      onSelect: () => undefined,
    }));

    expect(child).toContain("sidebar-session-row--child");
    expect(child).toContain("lucide-trash2");
    expect(parent).toContain('aria-expanded="true"');
    expect(parent).toContain("sidebar-session-disclosure is-expanded");
  });

  it("does not label advisory Codex occupancy as read-only in sidebar mappings", () => {
    expect(appSource.match(/occupiedExternally: (?:session|child)\.agentType !== "codex"/g))
      .toHaveLength(3);
  });

  it("renders an accessible pin action before delete and keeps pinned state visible", () => {
    const html = renderToStaticMarkup(createElement(SidebarSessionRow, {
      session: {
        id: "session-1",
        title: "Pinned conversation",
        visualState: "completed",
        statusLabel: "已完成",
        occupiedExternally: false,
        canDelete: true,
        active: false,
        pinned: true,
      },
      onSelect: () => undefined,
      onPin: () => undefined,
      onDelete: () => undefined,
    }));

    expect(html).toContain('aria-label="取消置顶：Pinned conversation"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("lucide-pin");
    expect(html.indexOf("sidebar-session-pin")).toBeLessThan(html.indexOf("sidebar-session-delete"));
    expect(rowSource).toContain("event.stopPropagation();");
  });

  it("does not expose pinning for child sessions", () => {
    const html = renderToStaticMarkup(createElement(SidebarSessionRow, {
      session: {
        id: "child-1",
        title: "Child conversation",
        visualState: "completed",
        statusLabel: "已完成",
        occupiedExternally: false,
        canDelete: true,
        active: false,
        child: true,
      },
      onSelect: () => undefined,
      onPin: () => undefined,
      onDelete: () => undefined,
    }));

    expect(html).not.toContain("sidebar-session-pin");
    expect(html).not.toContain("lucide-pin");
  });
});

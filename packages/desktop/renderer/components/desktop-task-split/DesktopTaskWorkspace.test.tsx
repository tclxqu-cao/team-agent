import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatViewProps } from "../ChatView";
import DesktopTaskWorkspace from "./DesktopTaskWorkspace";

function Conversation(props: ChatViewProps) {
  return createElement("div", null, props.activeAgentType,
    props.onOpenTaskSplit ? createElement("button", null, "task-split") : null,
    props.onReplaceTask ? createElement("button", null, "replace-task") : null);
}

describe("desktop-only task workspace", () => {
  it("leaves the browser and phone conversation untouched", () => {
    const result = renderToStaticMarkup(createElement(DesktopTaskWorkspace, {
      enabled: false, onFocusSession: () => {}, onNavigateSession: () => {},
      children: createElement(Conversation, { activeAgentType: "codex" }),
    }));
    expect(result).toBe("<div>codex</div>");
  });
  it("adds the desktop entry and task replacement without changing the chosen Agent", () => {
    const result = renderToStaticMarkup(createElement(DesktopTaskWorkspace, {
      enabled: true, onFocusSession: () => {}, onNavigateSession: () => {},
      children: createElement(Conversation, { activeAgentType: "claude-code" }),
    }));
    expect(result).toContain("claude-code");
    expect(result).toContain("task-split");
    expect(result).toContain("replace-task");
  });
});

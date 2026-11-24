import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ComposerAgentPicker, { agentPickerItems } from "./ComposerAgentPicker";
import ComposerWorkspacePicker, { workspacePickerLabel } from "./ComposerWorkspacePicker";
import type { RuntimeHealth } from "../../../shared/src/contracts/agent-api";

const noop = () => {};
const WORKSPACES = [
  { id: "p1", name: "customer-agent", path: "/Users/caoqu/team-agent/customer-agent" },
  { id: "p2", name: "历史会话", path: "/tmp/legacy-workspace", canCreateSession: false },
];

describe("ComposerAgentPicker", () => {
  it("shows the current agent on a collapsed menu trigger", () => {
    const html = renderToStaticMarkup(createElement(ComposerAgentPicker, { value: "claude-code", onChange: noop }));
    expect(html).toContain("Claude Code");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-composer-agent-picker="claude-code"');
    expect(html).not.toContain('role="menu"');
  });

  it("shows only available options and checks the current one", () => {
    const health: RuntimeHealth[] = [
      { agentType: "codex", available: false, label: "Codex", error: "not installed" },
      { agentType: "claude-code", available: true, label: "Claude Code" },
    ];
    const html = renderToStaticMarkup(createElement(ComposerAgentPicker, { value: "claude-code", health, onChange: noop, defaultOpen: true }));
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(2);
    expect(html).not.toContain("Codex");
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("✓");
  });

  it("uses only reported available native engines", () => {
    const items = agentPickerItems([{ agentType: "opencode", available: false, label: "OpenCode" }, { agentType: "codex", available: true, label: "Codex" }]);
    expect(items.map(item => item.agentType)).toEqual(["customer-agent", "codex"]);
    expect(agentPickerItems().map(item => item.agentType)).toEqual(["customer-agent"]);
  });
});

describe("ComposerAgentPicker multiple recipients", () => {
  it("offers separate single and multiple selection actions without a confirmation button", () => {
    const html = renderToStaticMarkup(createElement(ComposerAgentPicker, {
      value: "codex", values: ["codex", "zcode"], onChange: noop, onValuesChange: noop,
      health: [{ agentType: "codex", available: true, label: "Codex" }, { agentType: "zcode", available: true, label: "ZCode" }], defaultOpen: true,
    }));
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(3);
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="仅使用 Codex"');
    expect(html).toContain('aria-label="取消选择 ZCode"');
    expect(html).toContain("点名称单选，勾选框多选 · 立即生效");
    expect(html).not.toContain("composer-agent-picker-done");
    expect(html).toContain("Agent · 2");
    expect(html).not.toContain('role="menuitemradio"');
  });

  it("limits recipient choices to participants and keeps joined Agents selectable during health outages", () => {
    const html = renderToStaticMarkup(createElement(ComposerAgentPicker, {
      value: "codex", values: ["zcode"], allowedAgentTypes: ["codex", "zcode"], purpose: "recipients",
      onChange: noop, onValuesChange: noop, defaultOpen: true,
    }));
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(2);
    expect(html).toContain("全部 Agent");
    expect(html).toMatch(/data-agent-type="codex" aria-label="仅使用 Codex" title=/);
    expect(html).toMatch(/data-agent-type="zcode" aria-label="仅使用 ZCode" title=/);
    expect(html).toContain('title="至少保留一个 Agent"');
    expect(html).not.toContain("Claude Code");
  });
});

describe("ComposerWorkspacePicker", () => {
  it("shows the selected directory name on a collapsed menu trigger", () => {
    const html = renderToStaticMarkup(createElement(ComposerWorkspacePicker, { value: "p1", workspaces: WORKSPACES, onChange: noop }));
    expect(html).toContain("customer-agent");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-composer-workspace-picker="p1"');
    expect(html).not.toContain('role="menu"');
  });

  it("lists names with paths, marks the current one and offers another folder", () => {
    const html = renderToStaticMarkup(createElement(ComposerWorkspacePicker, {
      value: "p1", workspaces: WORKSPACES, onChange: noop, onPickFolder: vi.fn(), defaultOpen: true,
    }));
    expect(html).toContain("/Users/caoqu/team-agent/customer-agent");
    expect(html).toContain("历史会话");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("✓");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("选择其他文件夹…");
  });

  it("falls back to 选择目录 and only the folder action when there are no workspaces", () => {
    const html = renderToStaticMarkup(createElement(ComposerWorkspacePicker, { value: null, workspaces: [], onChange: noop, onPickFolder: noop, defaultOpen: true }));
    expect(html).toContain("选择目录");
    expect(html).toContain("选择文件夹…");
    expect(html).not.toContain("选择其他文件夹");
  });

  it("resolves the collapsed label from name, path basename and null", () => {
    expect(workspacePickerLabel("p1", WORKSPACES)).toEqual({ label: "customer-agent", path: WORKSPACES[0].path });
    expect(workspacePickerLabel("/tmp/foo/", [])).toEqual({ label: "foo", path: "/tmp/foo/" });
    expect(workspacePickerLabel(null, [])).toEqual({ label: "选择目录" });
  });
});

describe("ChatView new-session composer wiring", () => {
  const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles/composer.css", import.meta.url), "utf8");

  it("keeps the new props optional and only renders the pickers for a fresh composer", () => {
    for (const prop of [
      "runtimeHealth?: RuntimeHealth[]",
      "onSelectAgent?: (agentType: AgentType) => void",
      "workspaces?: Array<{ id: string; name: string; path: string; canCreateSession?: boolean }>",
      "onSelectWorkspace?: (projectId: string) => void",
      "onPickWorkspaceFolder?: () => void",
      "focusComposerNonce?: number",
    ]) expect(chatView).toContain(prop);
    expect(chatView).toContain("const isNewSessionComposer = !selectedSessionId && !viewSessionId;");
    expect(chatView).toContain("<ComposerWorkspacePicker");
    expect(chatView).toContain("<ComposerAgentPicker");
    expect(chatView).toContain("inputRef.current?.focus();");
  });

  it("styles both pickers with theme variables and a chat-covering menu layer", () => {
    expect(css).toContain(".composer-agent-picker-menu");
    expect(css).toContain(".composer-workspace-picker-menu");
    expect(css).toContain("z-index: 1300");
    expect(css).toContain("min(320px, calc(100vw - 32px))");
  });
});

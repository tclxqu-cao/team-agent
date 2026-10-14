import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  groupFixture,
  stateFixture,
} from "../../../../core/src/domain/collaboration/__tests__/fixtures";
import CollaborationPage from "./CollaborationPage";

const fixture = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./useCollaborationDiscussion", () => ({
  useCollaborationDiscussion: () => fixture.value,
}));

describe("collaboration group history presentation", () => {
  it("identifies speakers with avatars and crowns only the owner, including owner questions", () => {
    fixture.value = {
      group: groupFixture(),
      discussion: {
        ...stateFixture(),
        messages: [
          { id: "user", kind: "user", content: "请开始协作", createdAt: "2026-10-14T00:00:00Z" },
          { id: "owner", kind: "owner", memberId: "owner", content: "我来分配任务", createdAt: "2026-10-14T00:00:01Z" },
          { id: "member", kind: "member", memberId: "b", content: "验证完成", createdAt: "2026-10-14T00:00:02Z" },
          { id: "question", kind: "question", memberId: "owner", content: "请确认目标", createdAt: "2026-10-14T00:00:03Z", question: { id: "q", resolved: true } },
        ],
      },
      selected: "d", history: [], error: "", busy: false,
      select: vi.fn(), create: vi.fn(), act: vi.fn(), send: vi.fn(), setError: vi.fn(), updateRole: vi.fn(),
    };
    const html = renderToStaticMarkup(createElement(CollaborationPage, { groupId: "g" }));
    const messages = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g)!;
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message).not.toContain("<header");
      expect(message).toContain('class="collab-message-body"');
      expect(message).toContain('role="img"');
    }
    expect(messages[0]).toContain('aria-label="你"');
    expect(messages[0]).toContain('title="你">你</span>');
    expect(messages[0]).not.toContain("collab-avatar-crown");
    expect(messages[1]).toContain('aria-label="总控 · Codex · 群主"');
    expect(messages[1]).toContain('data-agent-icon="codex"');
    expect(messages[1]).toContain("collab-avatar-crown");
    expect(messages[2]).toContain('aria-label="验证 · Claude Code"');
    expect(messages[2]).toContain('data-agent-icon="claude-code"');
    expect(messages[2]).not.toContain("collab-avatar-crown");
    expect(messages[3]).toContain("collab-avatar-crown");
    expect(messages[3]).toContain("已处理");
  });

  it("places persisted discussion history beneath the member roster and renders the selected discussion", () => {
    const state = {
      ...stateFixture(),
      title: "当前讨论",
      messages: [
        {
          id: "msg",
          kind: "user",
          content: "当前讨论的历史消息",
          createdAt: "2026-10-14T00:00:00Z",
        },
      ],
    };
    fixture.value = {
      group: groupFixture(),
      discussion: state,
      selected: "d",
      history: [
        {
          id: "d",
          title: "当前讨论",
          status: "running",
          updatedAt: "2026-10-14T00:00:00Z",
        },
        {
          id: "old",
          title: "昨天的群聊",
          status: "completed",
          updatedAt: "2026-10-13T00:00:00Z",
        },
      ],
      error: "",
      busy: false,
      select: vi.fn(),
      create: vi.fn(),
      act: vi.fn(),
      send: vi.fn(),
      setError: vi.fn(),
      updateRole: vi.fn(),
    };
    const html = renderToStaticMarkup(
      createElement(CollaborationPage, { groupId: "g" }),
    );
    expect(html.indexOf('aria-label="群成员"')).toBeLessThan(
      html.indexOf('aria-label="群聊记录"'),
    );
    expect(html.indexOf('aria-label="群聊记录"')).toBeLessThan(
      html.indexOf("collab-sidebar-footer"),
    );
    expect(html).toContain("昨天的群聊");
    expect(html).toContain("当前讨论的历史消息");
    expect(html).toContain('aria-current="page"');
    expect(fixture.value.send).not.toHaveBeenCalled();
  });
});

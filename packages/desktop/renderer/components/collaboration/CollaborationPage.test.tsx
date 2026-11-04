import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisionMessage } from "../../../../core/src/domain/supervision/types";
import {
  groupFixture,
  stateFixture,
} from "../../../../core/src/domain/collaboration/__tests__/fixtures";
import CollaborationPage from "./CollaborationPage";

function renderDiscussion(state: ReturnType<typeof stateFixture>) {
  fixture.value = {
    group: groupFixture(), discussion: state, selected: state.id,
    history: [], error: "", busy: false,
    select: vi.fn(), create: vi.fn(), act: vi.fn(), send: vi.fn(),
    setError: vi.fn(), updateRole: vi.fn(),
  };
  return renderToStaticMarkup(createElement(CollaborationPage, { groupId: "g" }));
}

function queuedDiscussion() {
  const state = stateFixture();
  state.messages = [{
    id: "user", kind: "user", content: "介绍大模型架构", createdAt: state.createdAt,
  }];
  state.tasks = [{
    id: "task", memberId: "a", title: "梳理架构", instructions: "只读分析",
    dependsOn: [], isolated: false, readOnly: true, status: "queued",
    result: "等待工作目录空闲",
  }];
  return state;
}

const fixture = vi.hoisted(() => ({ value: {} as Record<string, unknown>, messages: [] as SupervisionMessage[] }));
vi.mock("./useCollaborationDiscussion", () => ({
  useCollaborationDiscussion: () => fixture.value,
}));
vi.mock("./useSupervisionMessages", () => ({ useSupervisionMessages: () => ({ messages: fixture.messages, error: "", loading: false, hasOlder: false, loadingOlder: false, loadOlder: vi.fn() }) }));
beforeEach(() => { fixture.messages = []; });

describe("collaboration group history presentation", () => {
  it("shows monitoring activity, sent and received content even when the group has no discussion", () => {
    const group = groupFixture(); group.monitoring = { supervisorId: "a", targets: [{ id: "source", agentType: "codex", title: "被监管任务", cwd: "/project" }] };
    fixture.value = { group, discussion: null, selected: null, history: [], error: "", busy: false, select: vi.fn(), create: vi.fn(), act: vi.fn(), send: vi.fn(), setError: vi.fn(), updateRole: vi.fn() };
    fixture.messages = [
      { id: "received", groupId: "g", direction: "received", title: "收到原会话进展", sender: "被监管任务", recipient: "开发", content: "任务中断，需要核对成果", sessionTitle: "被监管任务", createdAt: "2026-11-02T12:00:00Z" },
      { id: "sent", groupId: "g", direction: "sent", title: "接续指令", sender: "开发", recipient: "被监管任务", content: "先核对 /project/result.md 后继续", createdAt: "2026-11-02T12:00:01Z" },
      { id: "old", groupId: "g", direction: "activity", title: "等待你决策", sender: "开发", content: "介入后仍未确认新进度", historical: true, createdAt: "2026-11-02T12:00:02Z" },
    ];
    const html = renderToStaticMarkup(createElement(CollaborationPage, { groupId: "g" }));
    expect(html).toContain("任务中断，需要核对成果"); expect(html).toContain("先核对"); expect(html).toContain("介入后仍未确认新进度");
    expect(html).toContain("被监管任务 → 开发"); expect(html).toContain("开发 → 被监管任务");
    expect(html).toContain("历史监工记录"); expect(html).toMatch(/datetime="2026-11-02T12:00:01Z"/i);
    expect(html).not.toContain("把目标交给这个群"); expect(html).toContain("监工动态");
    expect(fixture.value.create).not.toHaveBeenCalled(); expect(fixture.value.send).not.toHaveBeenCalled();
  });
  it("explains workspace contention in the conversation and roster when nothing is executing", () => {
    const html = renderDiscussion(queuedDiscussion());
    expect(html).toContain("1 个任务等待工作目录空闲，空闲后会自动继续。");
    expect(html).toContain('data-status="queued"');
    expect(html).toContain('aria-label="等待工作目录空闲"');
    expect(html).toContain('class="collab-member-status">等待目录空闲');
    const activity = html.match(/<div class="collab-live-status[^>]*>[\s\S]*?<\/div>/)?.[0];
    expect(activity).toContain('role="status"');
    expect(activity).not.toContain("collab-spin");
    expect(html).toContain("介绍大模型架构");
    expect(fixture.value.send).not.toHaveBeenCalled();
  });

  it("keeps actual execution visible when other members are queued", () => {
    const state = queuedDiscussion();
    state.tasks.push({
      ...state.tasks[0], id: "active", memberId: "b", status: "running",
      title: "比较架构", result: undefined,
    });
    const html = renderDiscussion(state);
    expect(html).toContain('data-status="running"');
    expect(html).toContain("验证：比较架构");
    expect(html).not.toContain("空闲后会自动继续");
  });

  it("shows pending owner coordination before treating queued work as blocked", () => {
    const state = queuedDiscussion();
    state.ownerPending = true;
    const html = renderDiscussion(state);
    expect(html).toContain("总控正在安排下一步");
    expect(html).not.toContain('data-status="queued"');
  });

  it("does not promise automatic execution after a discussion is stopped", () => {
    const state = queuedDiscussion();
    state.status = "stopped";
    const html = renderDiscussion(state);
    expect(html).toContain('data-status="stopped"');
    expect(html).not.toContain("空闲后会自动继续");
    expect(html).not.toContain('class="collab-member-status">等待目录空闲');
  });

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

  it("exposes the mode toggle and chat-mode silent hint in the composer", () => {
    fixture.value = {
      group: groupFixture(),
      discussion: stateFixture(),
      selected: "d",
      history: [],
      error: "",
      busy: false,
      select: vi.fn(),
      create: vi.fn(),
      act: vi.fn(),
      setMode: vi.fn(),
      send: vi.fn(),
      setError: vi.fn(),
      updateRole: vi.fn(),
    };
    const graph = renderToStaticMarkup(
      createElement(CollaborationPage, { groupId: "g" }),
    );
    expect(graph).toContain('aria-label="讨论模式"');
    expect(graph).toContain('aria-pressed="true"');
    expect(graph).toContain("补充要求会交给群主继续安排");

    fixture.value = {
      ...fixture.value,
      discussion: { ...stateFixture(), mode: "chat" },
    };
    const chat = renderToStaticMarkup(
      createElement(CollaborationPage, { groupId: "g" }),
    );
    expect(chat).toContain("@直聊");
    expect(chat).toContain("@成员 或 @群主，说说要做什么…");
    expect(chat).toContain("无 @ 不会回应");
  });
});

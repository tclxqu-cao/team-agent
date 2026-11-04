import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SupervisionMessage } from "../../../../core/src/domain/supervision/types";
import { groupFixture } from "../../../../core/src/domain/collaboration/__tests__/fixtures";
import SupervisionMessageItem from "./SupervisionMessageItem";

function setup() {
  const group = groupFixture();
  group.members[1].agentType = "opencode";
  group.monitoring = {
    supervisorId: "a",
    targets: [{ id: "source", title: "开发", agentType: "claude-code", cwd: "/project" }],
  };
  const message: SupervisionMessage = {
    id: "m", groupId: group.id, direction: "received", title: "收到原会话进展",
    sender: "开发", recipient: "开发", content: "核对已有成果", sessionId: "source",
    sessionTitle: "开发", createdAt: "2026-11-02T12:00:00Z",
  };
  const render = () => renderToStaticMarkup(createElement(SupervisionMessageItem, { message, group }));
  return { group, message, render };
}

describe("supervision participant icons", () => {
  it("uses the source Agent for the avatar and the supervisor Agent for the recipient, even with matching names", () => {
    const { render } = setup();
    const html = render();
    expect(html).toContain('role="img" aria-label="开发 · Claude Code"');
    const route = html.slice(html.indexOf('class="collab-supervision-message-route"'));
    expect(route).toContain('data-agent-icon="claude-code"');
    expect(route).toContain('data-agent-icon="opencode"');
    expect(html).not.toContain("lucide-arrow-down-left");
  });

  it("reverses the participant icons when the supervisor sends to the monitored session", () => {
    const { message, render } = setup();
    message.direction = "sent";
    const html = render();
    expect(html).toContain('role="img" aria-label="开发 · OpenCode"');
    expect(html.indexOf('title="开发 · OpenCode"', html.indexOf("message-route"))).toBeLessThan(
      html.indexOf('title="开发 · Claude Code"', html.indexOf("message-route")),
    );
  });

  it("keeps saved Agent identities after the members and monitored sessions change", () => {
    const { group, message, render } = setup();
    message.senderAgentType = "zcode";
    message.recipientAgentType = "qoder";
    group.members = [];
    group.monitoring = undefined;
    const html = render();
    expect(html).toContain('role="img" aria-label="开发 · ZCode"');
    expect(html).toContain('data-agent-icon="qoder"');
  });

  it("uses the supervisor brand for historical activity without inventing a source Agent", () => {
    const { message, render } = setup();
    message.direction = "activity";
    message.sender = "监工";
    message.recipient = undefined;
    message.historical = true;
    const html = render();
    expect(html).toContain('role="img" aria-label="监工 · OpenCode"');
    expect(html).toContain("历史监工记录");
    expect(html).not.toContain('data-agent-icon="claude-code"');
  });

  it("keeps user messages distinct and does not assign system inspection to an Agent", () => {
    const { message, render } = setup();
    message.sender = "你";
    expect(render()).toContain('title="你">你</span>');
    message.sender = "监管巡检";
    const html = render();
    expect(html).toContain('role="img" aria-label="监管巡检"');
    expect(html.slice(0, html.indexOf('class="collab-message-body"'))).not.toContain("data-agent-icon");
    expect(html).toContain('data-agent-icon="opencode"');
  });
});

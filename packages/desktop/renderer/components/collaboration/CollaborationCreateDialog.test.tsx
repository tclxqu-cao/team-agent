import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { groupFixture } from "../../../../core/src/domain/collaboration/__tests__/fixtures";
import CollaborationCreateDialog from "./CollaborationCreateDialog";

describe("collaboration working directory selection", () => {
  const callbacks = { health: [], onClose: vi.fn(), onCreated: vi.fn() };

  it("offers a directory picker and prevents creating a group before a directory is selected", () => {
    const html = renderToStaticMarkup(createElement(CollaborationCreateDialog, callbacks));
    expect(html).toContain('aria-label="选择工作目录" aria-haspopup="dialog"');
    expect(html).toContain('class="collab-directory-picker"');
    expect(html).not.toContain("输入宿主机目录");
    expect(html).toContain('disabled="" type="submit"');
  });

  it("shows an existing directory as a selectable path while preserving the edit form", () => {
    const html = renderToStaticMarkup(createElement(CollaborationCreateDialog, {
      ...callbacks, initialGroup: groupFixture(),
    }));
    expect(html).toContain('title="/project"');
    expect(html).toContain("/project</span>");
    expect(html).not.toContain('value="/project"');
    expect(html).toContain("保存修改");
    expect(html).not.toContain('disabled="" type="submit"');
  });

  it("preserves an existing group's choice to link sessions without enabling a supervisor", () => {
    const group = groupFixture();
    group.monitoring = { targets: [{ id: "source", agentType: "codex", title: "原始会话", cwd: "/project" }] };
    const render = () => renderToStaticMarkup(createElement(CollaborationCreateDialog, { ...callbacks, initialGroup: group }));
    expect(render()).toContain('<option value="" selected="">仅关联，不启用监工</option>');
    group.monitoring.supervisorId = group.ownerId;
    expect(render()).toContain(`<option value="${group.ownerId}" selected="">`);
  });
});

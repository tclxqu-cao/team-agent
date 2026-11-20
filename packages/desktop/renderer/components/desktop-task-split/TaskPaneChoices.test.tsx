import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TaskPaneChoices from "./TaskPaneChoices";

describe("TaskPaneChoices", () => {
  it("includes the terminal entry alongside the existing pane choices", () => {
    const html = renderToStaticMarkup(
      <TaskPaneChoices onTask={() => {}} onDraft={() => {}} onSurface={() => {}} />,
    );

    expect(html).toContain(">终端</span>");
  });
});

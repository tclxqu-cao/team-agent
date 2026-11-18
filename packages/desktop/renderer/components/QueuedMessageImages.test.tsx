import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import QueuedMessageImages from "./QueuedMessageImages";

describe("queued message image previews", () => {
  it("keeps attachments visible in the queue with preview controls", () => {
    const html = renderToStaticMarkup(createElement(QueuedMessageImages, {
      images: ["data:image/png;base64,first", "data:image/jpeg;base64,second"], onPreview: () => {},
    }));
    expect(html).toContain('aria-label="2 张排队图片"');
    expect(html).toContain('aria-label="放大查看排队图片 2"');
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('src="data:image/jpeg;base64,second"');
  });
  it("does not add an empty image strip to text messages", () => {
    expect(renderToStaticMarkup(createElement(QueuedMessageImages, { onPreview: () => {} }))).toBe("");
  });
});

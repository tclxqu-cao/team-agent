import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MessageMedia from "./MessageMedia";

describe("MessageMedia", () => {
  it("renders video controls in the message without autoplay or visible paths", () => {
    const html = renderToStaticMarkup(createElement(MessageMedia, {
      path: "https://example.com/movie.mp4?sig=abc", label: "演示", kind: "video",
    }));
    expect(html).toContain("<video");
    expect(html).toContain('controls=""');
    expect(html).toContain('playsinline=""');
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain(">https://");
  });

  it("renders images directly with a zoom action", () => {
    const html = renderToStaticMarkup(createElement(MessageMedia, {
      path: "https://example.com/picture.png", label: "效果图", kind: "image",
    }));
    expect(html).toContain("<img");
    expect(html).toContain('alt="效果图"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("放大图片");
    expect(html).not.toContain("<video");
  });

  it("never exposes host paths as file URLs", () => {
    const html = renderToStaticMarkup(createElement(MessageMedia, {
      path: "/private/work/movie.mp4", label: "/private/work/movie.mp4", kind: "video",
    }));
    expect(html).toContain("正在加载movie.mp4");
    expect(html).not.toContain("/private/work");
    expect(html).not.toContain("file://");
  });
});

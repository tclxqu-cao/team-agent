import { describe, expect, it } from "vitest";
import { messageMediaKind, resolveMessageMediaPath } from "./message-media";
import { normalizeMessageLinks, parseRichInlineTokens } from "./markdown-links";

describe("message media", () => {
  it("resolves screenshot markdown and ordinary image links against the session workspace", () => {
    const path = "outputs/hotel-coupon-stage-acceptance-20261021/normal-101307484132.png";
    for (const text of [`![截图](${path})`, `[查看截图](${path})`]) {
      expect(parseRichInlineTokens(text)).toEqual([{ type: "artifact", label: text.startsWith("!") ? "截图" : "查看截图", path, raw: text }]);
    }
    expect(messageMediaKind(path)).toBe("image");
    expect(resolveMessageMediaPath(path, "/Users/example/refund")).toBe(`/Users/example/refund/${path}`);
    expect(resolveMessageMediaPath("./clip.mp4", "C:\\repo")).toBe("C:\\repo\\./clip.mp4");
    expect(resolveMessageMediaPath(path, null)).toBeNull();
    expect(resolveMessageMediaPath("javascript:alert.png", "/repo")).toBeNull();
    expect(parseRichInlineTokens("`source.ts`")).toEqual([{ type: "code", value: "source.ts" }]);
  });
  it("normalizes Harness multiline angle-bracket image and video paths", () => {
    const message = "![科技风封面](<\n/Users/example/cover tech.jpg\n>)\n\n[成片](<\n/Users/example/final.mp4\n>)";
    const normalized = normalizeMessageLinks(message);
    expect(normalized).toBe("![科技风封面](/Users/example/cover tech.jpg)\n\n[成片](/Users/example/final.mp4)");
    expect(parseRichInlineTokens(normalized).filter(token => token.type === "artifact")).toHaveLength(2);
  });

  it("preserves fenced code and unsafe protocols", () => {
    const code = "```md\n![example](<\n/tmp/cover.jpg\n>)\n```\n![real](<\n/tmp/real.jpg\n>)";
    expect(normalizeMessageLinks(code)).toBe("```md\n![example](<\n/tmp/cover.jpg\n>)\n```\n![real](/tmp/real.jpg)");
    const unsafe = "![bad](<\njavascript:alert(1)\n>)";
    expect(normalizeMessageLinks(unsafe)).toBe(unsafe);
  });

  it.each([
    ["/tmp/photo.png", "image"], ["~/photo.JPG", "image"],
    ["C:\\work\\clip.mp4", "video"], ["/tmp/clip.mov", "video"],
    ["https://example.com/clip.webm?signature=abc#t=1", "video"],
    ["https://example.com/photo.webp?signature=abc", "image"],
    ["/tmp/notes.md", null], ["/tmp/code.ts", null], ["/tmp/slides.pdf", null],
    ["javascript:alert(1).png", null], ["file:///tmp/photo.png", null],
    ["https://example.com/page?name=photo.png", null], ["/tmp/photo.png\n", null],
  ])("classifies %s as %s", (path, expected) => {
    expect(messageMediaKind(path)).toBe(expected);
  });

  it("recognizes image markdown without leaving a stray exclamation mark", () => {
    expect(parseRichInlineTokens("![效果图](/tmp/result.png)")).toEqual([
      { type: "artifact", label: "效果图", path: "/tmp/result.png", raw: "![效果图](/tmp/result.png)" },
    ]);
  });

  it("recognizes bare paths, inline paths and signed media links", () => {
    for (const text of ["/tmp/result.mp4", "`/tmp/result.mp4`", "[视频](https://example.com/result.mp4?sig=abc)"]) {
      const tokens = parseRichInlineTokens(text);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe("artifact");
    }
  });
});

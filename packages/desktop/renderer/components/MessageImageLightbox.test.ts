import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lightbox = readFileSync(new URL("./MessageImageLightbox.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

describe("MessageImageLightbox", () => {
  it("renders an accessible body-level image dialog", () => {
    expect(lightbox).toContain("return createPortal(");
    expect(lightbox).toContain("document.body");
    expect(lightbox).toContain('role="dialog"');
    expect(lightbox).toContain('aria-modal="true"');
    expect(lightbox).toContain('className="message-image-lightbox__image"');
    expect(lightbox).toContain("src={image.src}");
  });

  it("closes from Escape, backdrop, or the icon button and restores scrolling", () => {
    expect(lightbox).toContain('event.key === "Escape"');
    expect(lightbox).toContain("event.target === event.currentTarget");
    expect(lightbox).toContain('aria-label="关闭图片预览"');
    expect(lightbox).toContain("const previousOverflow = document.body.style.overflow");
    expect(lightbox).toContain("document.body.style.overflow = previousOverflow");
  });

  it("fits the original image inside desktop and mobile viewports", () => {
    expect(css).toContain(".message-image-lightbox {");
    expect(css).toContain("padding: max(16px, env(safe-area-inset-top))");
    expect(css).toContain(".message-image-lightbox__image {");
    expect(css).toContain("max-height: calc(100dvh - 32px)");
    expect(css).toContain("object-fit: contain");
  });
});

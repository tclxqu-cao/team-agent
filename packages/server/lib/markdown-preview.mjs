import { Marked } from "marked";

export const MAX_MARKDOWN_PREVIEW_BYTES = 8 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkdn", "mdx"]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function isMarkdownPreviewPath(filePath) {
  const extension = String(filePath).split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTENSIONS.has(extension);
}

export function renderMarkdownPreviewDocument(source, { title = "Markdown Preview" } = {}) {
  const rendered = markdown.parse(String(source), { async: false });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; line-height: 1.65; overflow-wrap: anywhere; }
    main { width: min(100% - 32px, 860px); margin: 0 auto; padding: 28px 0 52px; }
    h1, h2, h3, h4, h5, h6 { margin: 1.45em 0 0.55em; line-height: 1.25; }
    h1 { margin-top: 0; padding-bottom: 0.35em; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); font-size: 2em; }
    h2 { padding-bottom: 0.3em; border-bottom: 1px solid color-mix(in srgb, CanvasText 13%, transparent); font-size: 1.5em; }
    p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
    ul, ol { padding-left: 1.7em; }
    blockquote { margin-left: 0; padding: 0.15em 1em; border-left: 4px solid #7aa2f7; color: color-mix(in srgb, CanvasText 72%, transparent); }
    a { color: LinkText; text-underline-offset: 0.16em; }
    img, video { display: block; max-width: 100%; height: auto; margin: 1em auto; }
    pre { max-width: 100%; overflow: auto; padding: 14px 16px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 6px; background: color-mix(in srgb, CanvasText 7%, Canvas); }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.9em; }
    :not(pre) > code { padding: 0.14em 0.35em; border-radius: 4px; background: color-mix(in srgb, CanvasText 8%, Canvas); }
    table { display: block; width: max-content; max-width: 100%; overflow-x: auto; border-spacing: 0; border-collapse: collapse; }
    th, td { padding: 7px 12px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); text-align: left; }
    th { background: color-mix(in srgb, CanvasText 7%, Canvas); }
    input[type="checkbox"] { margin: 0 0.45em 0.2em; }
    .task-list-item { list-style: none; }
    hr { height: 1px; margin: 1.5em 0; border: 0; background: color-mix(in srgb, CanvasText 16%, transparent); }
    @media (max-width: 520px) { main { width: min(100% - 24px, 860px); padding-top: 20px; } h1 { font-size: 1.65em; } h2 { font-size: 1.3em; } }
  </style>
</head>
<body><main>${rendered}</main></body>
</html>`;
}

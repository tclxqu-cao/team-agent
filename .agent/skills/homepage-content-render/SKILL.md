---
name: homepage-content-render
description: Render polished homepage content as one validated PortfolioArtifactV1 JSON object.
---

# Homepage Content Render

Render the polished draft as `PortfolioArtifactV1`. Return exactly one JSON object
with no Markdown fence or surrounding prose:

```json
{"schemaVersion":1,"skill":"portfolio-chat","title":"...","blocks":[{"type":"text","text":"..."}],"suggestions":[],"sources":[],"generatedAt":"ISO-8601"}
```

Contract:

- `skill` is the canonical content kind: `portfolio-help`, `portfolio-whoami`, `portfolio-works`, `portfolio-jobs`, `portfolio-timeline`, `portfolio-contact`, `portfolio-project-<id>`, or `portfolio-chat`.
- `blocks` contains 1 to 24 `text`, `html`, `image`, or `video` blocks.
- An HTML block puts its markup in `html`, never `text`. Example: `{"type":"html","html":"<div class='artifact-panel'>...</div>"}`.
- Every `image` or `video` block must put its media path in `src`, never `url`. A video poster stays in `poster`. Example: `{"type":"video","src":"/assets/demo.mp4","poster":"/assets/demo.jpg"}`.
- Use `html` only for meaningful structured layouts. Allowed reusable classes include `artifact-grid`, `artifact-flow-step`, `artifact-panel`, `artifact-meta`, and `artifact-actions`.
- Because `html` is inside a double-quoted JSON string, use single quotes for every HTML attribute. Never place an unescaped double quote inside the `html` value.
- Return compact single-line JSON. Escape every newline, tab, carriage return, and other control character inside JSON string values; never place a literal control character inside a string.
- HTML must not contain `script`, `style`, `iframe`, `object`, `embed`, `form`, event attributes, inline styles, or `javascript:` URLs.
- Image and video `src` values must be `http(s)` URLs or paths below `/assets/`; never invent media paths.
- Preserve the polished draft's vault-relative `sources`.
- For ordinary chat, prefer one text block and `portfolio-chat`.

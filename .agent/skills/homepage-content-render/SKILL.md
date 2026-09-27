---
name: homepage-content-render
description: Render polished homepage content as one validated PortfolioArtifactV1 JSON object.
---

# Homepage Content Render

Render the polished draft as `PortfolioArtifactV1`. Return exactly one JSON object
with no Markdown fence or surrounding prose:

```json
{"schemaVersion":1,"skill":"portfolio-chat","title":"...","blocks":[{"type":"html","sandbox":true,"html":"<main class='scene'>...</main>","css":".scene{...}","script":"..."}],"suggestions":[],"sources":[],"generatedAt":"ISO-8601"}
```

Contract:

- `skill` is the canonical content kind: `portfolio-help`, `portfolio-whoami`, `portfolio-works`, `portfolio-jobs`, `portfolio-timeline`, `portfolio-contact`, `portfolio-project-<id>`, or `portfolio-chat`.
- `blocks` contains 1 to 24 `text`, `html`, `image`, or `video` blocks.
- An HTML block puts its markup in `html`, never `text`.
- Every `image` or `video` block must put its media path in `src`, never `url`. A video poster stays in `poster`. Example: `{"type":"video","src":"/assets/demo.mp4","poster":"/assets/demo.jpg"}`.
- Every generated answer must contain one primary HTML block with `sandbox: true`, including greetings, acknowledgements, errors, and ordinary chat. Do not return a text-only artifact.
- Put the visual body fragment in `html`, generated styles in `css`, and optional local interaction code in `script`. Always include all three fields; use an empty string when no script is useful.
- Compose the response specifically for the question. Do not reuse one fixed card or grid template for every answer.
- Select a fitting information form: compact signal for greetings, editorial explanation for concepts, comparison matrix for alternatives, timeline for history, pipeline for processes, dashboard for metrics or jobs, code console for technical detail, or another coherent original composition.
- Vary hierarchy, rhythm, density, borders, color accents, and motion according to the content while keeping the result recognizably part of a technical terminal.
- The sandbox already provides terminal theme variables: `--bg`, `--surface`, `--surface-strong`, `--line`, `--line-soft`, `--text`, `--text-soft`, `--muted`, `--green`, `--cyan`, `--yellow`, `--red`, `--blue`, `--heading`, `--media-bg`, `--mono`, and `--sans`. Use them when they strengthen integration, and add local custom properties when the composition needs them.
- Use semantic HTML, concise headings, short paragraphs, lists, tables, figures, SVG, or canvas as appropriate. Break long content into scannable regions; never place the entire answer in one large paragraph.
- CSS animation and transitions are allowed. Keep motion purposeful, avoid constant high-frequency movement, and make the first frame readable before animation starts.
- JavaScript may animate or add interaction inside this answer. It must not use `fetch`, `XMLHttpRequest`, `WebSocket`, storage, cookies, `parent`, `top`, `opener`, navigation, popups, downloads, or form submission.
- Use responsive CSS that works from 320px wide through desktop. Prevent horizontal page overflow and ensure long Chinese, English, URLs, and code remain readable.
- Do not generate sexual or pornographic content, insults, harassment, degrading language, or hateful content.
- Choose labels from the content rather than adding fake system facts. Do not imply that data was verified, deployed, live, or successful unless the evidence supports that claim.
- Because `html` is inside a double-quoted JSON string, use single quotes for every HTML attribute. Never place an unescaped double quote inside the `html` value.
- Return compact single-line JSON. Escape every newline, tab, carriage return, backslash, quote, and other control character inside JSON string values; never place a literal control character inside a string.
- `html` is a body fragment. It must not contain `html`, `head`, `body`, `script`, `style`, `iframe`, `object`, `embed`, `form`, `base`, `link`, or `meta` elements. Put code in `css` and `script` instead.
- Image and video `src` values must be `http(s)` URLs or paths below `/assets/`; never invent media paths.
- Preserve the polished draft's vault-relative `sources`.

Adaptive compact example:

```json
{"type":"html","sandbox":true,"html":"<main class='signal'><span>ONLINE</span><h2>你好</h2><p>简短而自然的回答。</p></main>","css":".signal{padding:18px;border-left:2px solid var(--cyan);background:linear-gradient(90deg,color-mix(in srgb,var(--cyan) 10%,transparent),transparent)}.signal span{color:var(--cyan);font:700 11px var(--mono)}.signal h2{margin:8px 0;color:var(--heading)}.signal p{margin:0;color:var(--text-soft)}","script":""}
```

Adaptive process example:

```json
{"type":"html","sandbox":true,"html":"<main class='pipeline'><header><span>PROCESS MAP</span><h2>问题对应的流程标题</h2></header><ol><li><b>01</b><div><strong>阶段一</strong><p>两到三句关键信息。</p></div></li><li><b>02</b><div><strong>阶段二</strong><p>继续展示下一步。</p></div></li></ol></main>","css":".pipeline{padding:8px 2px;color:var(--text)}header span{color:var(--cyan);font:700 11px var(--mono)}h2{margin:8px 0 20px;color:var(--heading)}ol{display:grid;gap:10px;margin:0;padding:0;list-style:none}li{display:grid;grid-template-columns:44px 1fr;gap:12px;padding:14px;border:1px solid var(--line);background:var(--surface)}li b{color:var(--green);font-family:var(--mono)}li strong{color:var(--heading)}li p{margin:5px 0 0;color:var(--text-soft)}","script":"document.querySelectorAll('li').forEach((item,index)=>item.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:360,delay:index*90,fill:'both'}));"}
```

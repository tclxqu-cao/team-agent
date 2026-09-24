---
name: portfolio-works
description: List Caoqu's public projects and the capabilities demonstrated by them.
triggers: /works, works, 工作, 项目, 做过什么
---

Before answering, call `public_wiki_query` with a focused query for all public portfolio projects and their evidence-backed capabilities. Use only the returned public knowledge and supplied context. Never invent facts, contacts, metrics, URLs, or media.

Return exactly one JSON object without Markdown fences using this shape:
`{"schemaVersion":1,"skill":"portfolio-works","title":"...","summary":"...","blocks":[{"type":"html","html":"<section class='artifact'>...</section>"}],"suggestions":["/timeline"],"sources":["vault-relative.md"]}`

`title` must be a non-empty string. Put the complete project catalog in exactly one HTML block. Do not return project descriptions as separate text, image, or video blocks; each project's own Skill is responsible for its media. Use single quotes for every HTML attribute so the outer JSON remains valid; never use an unescaped double quote inside the HTML string. Source paths must be public vault-relative Markdown paths.

Build an editorial project index instead of a table. The HTML must use this exact structure:

- One `section.artifact` containing `p.artifact-kicker`, `h2.artifact-title`, one short `p.t-lead`, and one `div.artifact-grid`.
- The grid contains exactly 10 `button.artifact-flow-step` elements in the project order below. Every button uses `type='button'`, an accurate Chinese `aria-label`, and the exact `data-command='/project PROJECT_ID'`.
- Each button contains, in order: `span.artifact-meta` with category, `strong` with the verified project name, one concise `span` with the core value, and `span.t-out` with `查看项目 →`.
- Keep every project card concise. Derive category and core value from public evidence. Do not include implementation details, private URLs, metrics, screenshots, inline styles, SVG, or decorative markup.
- Use only these allowed classes: `artifact`, `artifact-kicker`, `artifact-title`, `artifact-meta`, `artifact-grid`, `artifact-flow-step`, `t-lead`, `t-out`.
- Do not return a Markdown table or an HTML table.

Projects to look up: agentroam (multi-agent desktop/web/mobile workspace), knowledge-base (traceable evidence-to-knowledge system), flow-studio (agent and workflow canvas), smart-refund (conversation understanding and refund workflow), agent-swarms (multi-agent review and InfQA), quality-platform (testing/release/quality reports), customer-service (ticket routing and quality management), meitu-web, vibe-works, kid-earth. Keep internal systems at the approved public abstraction level. Write concise Chinese display content while preserving verified English project names and commands.

Project order and commands: AgentRoam (`/project agentroam`), Personal Knowledge Base (`/project knowledge-base`), Flow Studio (`/project flow-studio`), Smart Refund / Small WOW (`/project smart-refund`), Agent Swarms (`/project agent-swarms`), Quality Platform (`/project quality-platform`), Customer Service and Ticketing (`/project customer-service`), Meitu Web (`/project meitu-web`), Vibe Works (`/project vibe-works`), Kid Earth (`/project kid-earth`).

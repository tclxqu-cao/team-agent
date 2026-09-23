---
name: portfolio-timeline
description: Generate Caoqu's public timeline from projects, later preferring public resume knowledge.
triggers: /timeline, timeline, 工作经验, 经历, 简历, 履历, 经理
---

Before answering, call `public_wiki_query` with a focused query for the public resume and dated project milestones. Use only the returned public knowledge and supplied context. Never invent facts, employers, positions, dates, metrics, URLs, or media.

Return exactly one JSON object without Markdown fences using this shape:
`{"schemaVersion":1,"skill":"portfolio-timeline","title":"...","summary":"...","blocks":[{"type":"html","html":"<section>...</section>"}],"suggestions":["/works"],"sources":["vault-relative.md"]}`

`title` must be a non-empty string. Put the complete timeline in exactly one HTML block; do not return milestones as separate text, image, or video blocks. Escape HTML quotes correctly inside the JSON string. Source paths must be public vault-relative Markdown paths.

Build a vertical timeline with `section`, `h2`, `p`, `ol`, `li`, `strong`, `h3`, and `span`. Each `li` is one milestone: begin with the verified date in `strong`, then the project or experience title in `h3`, followed by one concise evidence-backed description. Order milestones from newest to oldest so the current work appears first. Do not use a table or a plain bullet summary.

For now build the timeline from project milestones: personal knowledge base, Kid Earth, AgentRoam, Flow Studio, smart refund / Small WOW, and Agent Swarms. If a public resume appears in context, prefer it. Do not invent employers, positions, or dates; omit milestones whose chronology cannot be supported. State briefly that the result is based on public evidence and is not a complete employment history when no public resume is available.

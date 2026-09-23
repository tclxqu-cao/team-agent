---
name: portfolio-works
description: List Caoqu's public projects and the capabilities demonstrated by them.
triggers: /works, works, 工作, 项目, 做过什么
---

Before answering, call `public_wiki_query` with a focused query for all public portfolio projects and their evidence-backed capabilities. Use only the returned public knowledge and supplied context. Never invent facts, contacts, metrics, URLs, or media.

Return exactly one JSON object without Markdown fences using this shape:
`{"schemaVersion":1,"skill":"portfolio-works","title":"...","summary":"...","blocks":[{"type":"html","html":"<section>...</section>"}],"suggestions":["/timeline"],"sources":["vault-relative.md"]}`

`title` must be a non-empty string. Put the project catalog in exactly one HTML block; do not return project descriptions as separate text, image, or video blocks. Escape HTML quotes correctly inside the JSON string. Source paths must be public vault-relative Markdown paths.

The HTML block must contain one semantic table using `section`, `h2`, `p`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `strong`, and `code`. Use these columns in this order: Project, Category, Core value, Demonstrated capabilities, Command. Include one row for every public project found in the public knowledge results. Keep each cell compact, derive capabilities from project evidence, and put the exact `/project PROJECT_ID` command in the final cell. Do not return a Markdown table and do not invent missing facts.

Projects to look up: agentroam (multi-agent desktop/web/mobile workspace), knowledge-base (traceable evidence-to-knowledge system), flow-studio (agent and workflow canvas), smart-refund (conversation understanding and refund workflow), agent-swarms (multi-agent review and InfQA), quality-platform (testing/release/quality reports), customer-service (ticket routing and quality management), meitu-web, vibe-works, kid-earth. Keep internal systems at the approved public abstraction level. Write concise Chinese display content while preserving verified English project names and commands.

---
name: portfolio-jobs
description: Present the read-only real job snapshot supplied by the homepage jobs workflow.
triggers: /jobs, /job, 岗位, 招聘, 找工作, 应聘
---

The read-only public context contains the job snapshot. Preserve its date, counts, URLs, and missing or stale warnings exactly. Never invent jobs, expose demo rows, infer missing requirements, or claim to apply for a job.

Return exactly one JSON object without Markdown fences using this shape:
`{"schemaVersion":1,"skill":"portfolio-jobs","title":"...","summary":"...","blocks":[{"type":"html","html":"<section>...</section>"}],"suggestions":["/jobs"],"generatedAt":"..."}`

`title` must be a non-empty string. Return only fields accepted by this schema. Because the HTML is inside a double-quoted JSON string, use single quotes for every HTML attribute and never put an unescaped double quote inside `html`.

When the user asks for a table, put the job list in exactly one `html` block containing a semantic table built from `section`, `p`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `strong`, and `a`. Use these columns in this order: #, 职位, 公司, 薪资, 城市, 经验/学历, 链接. Use `-` for missing display fields. Render each supplied job URL exactly as `<a href='https://example.com/job'>查看岗位</a>` with the real URL substituted; never use Markdown link syntax inside `href`. Do not return a Markdown table.

For other presentation requests, follow the requested compact layout using only supported text or safe HTML blocks. Keep the snapshot warning visible and do not change the underlying job data.

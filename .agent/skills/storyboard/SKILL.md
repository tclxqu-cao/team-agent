---
name: storyboard
description: >
  Generate video storyboards from materials (images, text, mixed assets).
  Creates shot breakdowns with preview images, generates video clips via
  a configurable endpoint, and composes final video with transitions.
  Use when user says "storyboard", "分镜", "生成视频", "视频制作",
  or invokes /storyboard.
model: gpt-4o
triggers: storyboard, 分镜, 生成视频, 视频制作
---

# Storyboard Video Generation Skill

This skill delegates to three independent providers — all endpoints, models,
and keys are supplied via environment variables, so nothing is baked in:

| Stage | Env vars | Default endpoint | Default model |
| --- | --- | --- | --- |
| Storyboard LLM | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | `https://api.openai.com` | `gpt-4o` |
| Preview image | `IMAGE_API_KEY`, `IMAGE_BASE_URL`, `IMAGE_MODEL` | `https://api.openai.com` | `dall-e-3` |
| Video clip | `VOLCENGINE_API_KEY`, `SEEDANCE_BASE_URL`, `SEEDANCE_MODEL` | `https://visual.volcengineapi.com` | `seedance-1-lite` |

The agent should surface these as editable fields in the UI so the user can
switch any of the three without editing this SKILL.md.

You are a video storyboard director. When the user provides materials (images,
text descriptions, or mixed assets) and a creative direction, you will:

## Workflow

### Step 1: Analyze materials and generate storyboard

Read the user's materials and creative direction. Run the storyboard generation
script:

```bash
bun run .agent/skills/storyboard/scripts/generate-storyboard.ts --materials "<user materials summary>" --direction "<creative direction>" --output /tmp/storyboard.json
```

This outputs a JSON file with the shot list. Then display the storyboard workbench:

```
Use show_widget with:
- widget_type: "storyboard_workbench"
- data: the storyboard JSON content
```

### Step 2: Generate preview images

For each shot in the storyboard, generate a preview image:

```bash
bun run .agent/skills/storyboard/scripts/render-preview.ts --storyboard /tmp/storyboard.json --output-dir /tmp/storyboard/previews
```

Update the workbench with preview image URLs using show_widget with the same
widget_id (update_id).

### Step 3: Generate video clips

Generate video for each shot using the configured video endpoint:

```bash
bun run .agent/skills/storyboard/scripts/generate-video.ts --storyboard /tmp/storyboard.json --previews-dir /tmp/storyboard/previews --output-dir /tmp/storyboard/videos
```

Update the workbench with video URLs using show_widget with update_id.

### Step 4: User review

Ask the user: "All video clips are ready. Would you like me to compose the
final video with transitions?"

If the user confirms, proceed to Step 5.

### Step 5: Compose final video

```bash
bun run .agent/skills/storyboard/scripts/compose-video.ts --videos-dir /tmp/storyboard/videos --storyboard /tmp/storyboard.json --output /tmp/storyboard/final.mp4
```

Update the workbench with the composed video URL using show_widget with update_id.

## Environment reference

All three scripts read the same env var families:

| Provider | Key | Base URL | Model |
| --- | --- | --- | --- |
| Storyboard LLM | `LLM_API_KEY` (or `OPENAI_API_KEY`) | `LLM_BASE_URL` (or `OPENAI_BASE_URL`) | `LLM_MODEL` |
| Preview image | `IMAGE_API_KEY` (or `LLM_API_KEY`) | `IMAGE_BASE_URL` (or `LLM_BASE_URL`) | `IMAGE_MODEL` |
| Video clip | `VOLCENGINE_API_KEY` | `SEEDANCE_BASE_URL` | `SEEDANCE_MODEL` |

Optional secondary env vars let you share credentials across stages. If a
variable is missing, the script prints which key it needs instead of silently
failing.

## Collecting Model & API Key via ask_user

Each script (`generate-storyboard.ts`, `render-preview.ts`, `generate-video.ts`) supports **three configuration methods**, checked in this order:

1. **CLI arguments**: `--api-key`, `--base-url`, `--model`
2. **Environment variables** (see table above)
3. **User interaction** (fallback when no key is configured)

### How the interactive flow works

When a script is run without an API key, it **does not crash**. Instead it outputs a structured JSON signal to stdout and exits with code 2:

```json
{
  "__ask_user": {
    "for": "video_config",
    "question": "缺少视频生成 API 配置...",
    "fields": [
      { "name": "apiKey", "label": "API Key", "description": "...", "type": "secret" },
      { "name": "model", "label": "模型 ID", "description": "可手动输入；留空使用所选推荐或默认模型", "type": "text" },
      { "name": "baseUrl", "label": "API Base URL（可选）", "description": "...", "type": "text" }
    ],
    "options": [
      { "label": "seedance-1-lite", "description": "Seedance 1 Lite — 快速、低成本；可被模型 ID 手动覆盖" },
      { "label": "seedance-1-pro", "description": "Seedance 1 Pro — 更高质量；可被模型 ID 手动覆盖" }
    ]
  }
}
```

### Agent responsibilities

When you receive output containing `__ask_user`:

1. **Parse the signal** — extract `for`, `question`, `fields`, and `options`
2. **Call `ask_user`** tool with the question:
   - Include the available models as selectable recommendations
   - Include editable fields for API Key, model ID, and optional Base URL
   - If the user types a model ID, use that value; otherwise use the selected recommendation or default
3. **Collect the user's response** — note the typed model ID, selected model label, API Key, and any Base URL they provide
4. **Re-run the script** with the collected values:
   ```bash
   bun run .agent/skills/storyboard/scripts/generate-video.ts \
     --storyboard /tmp/storyboard.json \
     --previews-dir /tmp/storyboard/previews \
     --output-dir /tmp/storyboard/videos \
     --api-key "<user-provided-key>" \
     --model "<typed-model-or-selected-recommendation>" \
     --base-url "<user-provided-url-or-default>"
   ```

### Model recommendations by stage

| Stage | Default | Recommended alternatives |
| --- | --- | --- |
| Storyboard LLM | `gpt-4o` | `claude-sonnet-4-20250514`, `gemini-2.5-pro` |
| Preview image | `dall-e-3` | `flux-1-pro` |
| Video clip | `seedance-1-lite` | `seedance-1-pro` |

## Important Notes

- Each script outputs JSON to stdout with progress updates
- If any shot fails, mark it as error in the workbench and continue with remaining shots
- The user can request regenerating individual shots — re-run the relevant script for that shot only
- Always use show_widget with update_id to update the existing workbench card, never create duplicates
- Endpoint/model are read at every invocation — restart the app after changing them
- When a script exits with code 2, check stdout for `__ask_user` signal — this is intentional, not an error

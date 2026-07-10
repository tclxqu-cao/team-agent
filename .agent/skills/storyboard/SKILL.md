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

## Important Notes

- Each script outputs JSON to stdout with progress updates
- If any shot fails, mark it as error in the workbench and continue with remaining shots
- The user can request regenerating individual shots — re-run the relevant script for that shot only
- Always use show_widget with update_id to update the existing workbench card, never create duplicates
- Endpoint/model are read at every invocation — restart the app after changing them

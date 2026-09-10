---
name: storyboard
description: >
  Generate video storyboards from materials (images, text, mixed assets).
  Creates shot breakdowns with preview images, generates video clips via
  Seedance 1 Lite, and composes final video with transitions.
  Use when user says "storyboard", "分镜", "生成视频", "视频制作",
  or invokes /storyboard.
triggers: storyboard, 分镜, 生成视频, 视频制作
---

# Storyboard Video Generation Skill

You are a video storyboard director. When the user provides materials (images, text descriptions, or mixed assets) and a creative direction, you will:

## Workflow

### Step 1: Analyze materials and generate storyboard

Read the user's materials and creative direction. Run the storyboard generation script:

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

Update the workbench with preview image URLs using show_widget with the same widget_id (update_id).

### Step 3: Generate video clips

Generate video for each shot using Seedance 1 Lite:

```bash
bun run .agent/skills/storyboard/scripts/generate-video.ts --storyboard /tmp/storyboard.json --previews-dir /tmp/storyboard/previews --output-dir /tmp/storyboard/videos --api-key "$VOLCENGINE_API_KEY"
```

Update the workbench with video URLs using show_widget with update_id.

### Step 4: User review

Ask the user: "All video clips are ready. Would you like me to compose the final video with transitions?"

If the user confirms, proceed to Step 5.

### Step 5: Compose final video

```bash
bun run .agent/skills/storyboard/scripts/compose-video.ts --videos-dir /tmp/storyboard/videos --storyboard /tmp/storyboard.json --output /tmp/storyboard/final.mp4
```

Update the workbench with the composed video URL using show_widget with update_id.

## Important Notes

- Each script outputs JSON to stdout with progress updates
- If any shot fails, mark it as error in the workbench and continue with remaining shots
- The user can request regenerating individual shots — re-run the relevant script for that shot only
- Always use show_widget with update_id to update the existing workbench card, never create duplicates

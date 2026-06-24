#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    storyboard: { type: "string" },
    "previews-dir": { type: "string" },
    "output-dir": { type: "string" },
    "api-key": { type: "string" },
  },
});

if (!values.storyboard || !values["output-dir"]) {
  console.error("Usage: generate-video.ts --storyboard <path> --previews-dir <dir> --output-dir <dir> --api-key <key>");
  process.exit(1);
}

const apiKey = values["api-key"] ?? process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = process.env.SEEDANCE_BASE_URL ?? "https://visual.volcengineapi.com";

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

async function generateVideoFromImage(imagePath: string, prompt: string, outputPath: string): Promise<void> {
  const imageBase64 = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64");

  // Seedance 1 Lite API call
  const response = await fetch(`${baseUrl}/v1/video/generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "seedance-1-lite",
      input: {
        image: `data:image/png;base64,${imageBase64}`,
        prompt: prompt,
      },
      parameters: {
        duration: 5,
        resolution: "720p",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Seedance API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const taskId = result.task_id ?? result.data?.task_id;
  if (!taskId) throw new Error("No task_id in Seedance response");

  // Poll for completion (Seedance is async)
  const MAX_POLLS = 60; // 5 min max
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusResp = await fetch(`${baseUrl}/v1/video/query?task_id=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const statusData = await statusResp.json();
    const status = statusData.status ?? statusData.data?.status;

    if (status === "success" || status === "completed") {
      const videoUrl = statusData.video_url ?? statusData.data?.video_url;
      if (!videoUrl) throw new Error("No video_url in completed task");
      const videoResp = await fetch(videoUrl);
      const buffer = await videoResp.arrayBuffer();
      await Bun.write(outputPath, buffer);
      return;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Video generation failed: ${JSON.stringify(statusData)}`);
    }
    console.error(`  Polling shot... (${i + 1}/${MAX_POLLS}) status: ${status}`);
  }
  throw new Error("Video generation timeout");
}

const results: Array<{ index: number; videoUrl: string; error?: string }> = [];

for (const shot of storyboard.shots) {
  const previewPath = `${values["previews-dir"]}/shot-${shot.index}.png`;
  const outputPath = `${values["output-dir"]}/shot-${shot.index}.mp4`;
  console.error(`Generating video for shot ${shot.index}...`);

  try {
    await generateVideoFromImage(previewPath, shot.prompt, outputPath);
    results.push({ index: shot.index, videoUrl: outputPath });
    console.error(`  ✅ Shot ${shot.index} video saved to ${outputPath}`);
  } catch (err: any) {
    console.error(`  ❌ Shot ${shot.index} video failed: ${err.message}`);
    results.push({ index: shot.index, videoUrl: "", error: err.message });
  }
}

// Update storyboard
for (const r of results) {
  const shot = storyboard.shots.find((s: any) => s.index === r.index);
  if (shot) {
    shot.videoUrl = r.videoUrl;
    shot.status = r.error ? "error" : "done";
    if (r.error) shot.error = r.error;
  }
}

storyboard.status = storyboard.shots.every((s: any) => s.status === "done") ? "video_ready" : "generating";
await Bun.write(values.storyboard, JSON.stringify(storyboard, null, 2));

console.log(JSON.stringify({ results, storyboard }));

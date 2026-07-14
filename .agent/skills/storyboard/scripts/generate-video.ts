#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    storyboard: { type: "string" },
    "previews-dir": { type: "string" },
    "output-dir": { type: "string" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
  },
});

if (!values.storyboard || !values["output-dir"]) {
  console.error("Usage: generate-video.ts --storyboard <path> --previews-dir <dir> --output-dir <dir> [--api-key <key>] [--base-url <url>] [--model <id>]");
  process.exit(1);
}

const apiKey = values["api-key"] ?? process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = values["base-url"] ?? process.env.SEEDANCE_BASE_URL ?? "https://visual.volcengineapi.com";
const model = values.model ?? process.env.SEEDANCE_MODEL ?? "seedance-1-lite";

const DEFAULT_VIDEO_MODELS = [
  { label: "seedance-1-lite", description: "Seedance 1 Lite — 快速、低成本，适合 5s 片段" },
  { label: "seedance-1-pro", description: "Seedance 1 Pro — 更高质量，支持更长时长" },
];

if (!apiKey) {
  const askPayload = {
    __ask_user: {
      for: "video_config",
      question: "缺少视频生成 API 配置。请提供火山引擎 API Key，或选择模型后继续（需要模型对应的 API Key）。",
      fields: [
        { name: "apiKey", label: "API Key", description: "火山引擎 VOLCENGINE_API_KEY（或兼容服务商的 Key）", type: "secret" },
        { name: "baseUrl", label: "API Base URL（可选）", description: "留空使用默认：https://visual.volcengineapi.com", type: "text" },
      ],
      options: DEFAULT_VIDEO_MODELS.map(m => ({ label: m.label, description: m.description })),
    },
  };
  console.log(JSON.stringify(askPayload));
  process.exit(2);
}

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

async function generateVideoFromImage(imagePath: string, prompt: string, outputPath: string): Promise<void> {
  const imageBase64 = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64");

  const response = await fetch(`${baseUrl}/v1/video/generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
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
    throw new Error(`Video API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const taskId = result.task_id ?? result.data?.task_id;
  if (!taskId) throw new Error("No task_id in video generation response");

  const MAX_POLLS = 60;
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

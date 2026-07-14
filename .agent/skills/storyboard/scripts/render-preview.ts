#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    storyboard: { type: "string" },
    "output-dir": { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
  },
});

if (!values.storyboard || !values["output-dir"]) {
  console.error("Usage: render-preview.ts --storyboard <path> --output-dir <dir> [--base-url <url>] [--model <id>]");
  process.exit(1);
}

const apiKey = process.env.IMAGE_API_KEY ?? process.env.LLM_API_KEY ?? "";
const baseUrl = values["base-url"] ?? process.env.IMAGE_BASE_URL ?? process.env.LLM_BASE_URL ?? "https://api.openai.com";
const model = values.model ?? process.env.IMAGE_MODEL ?? "dall-e-3";

const DEFAULT_IMAGE_MODELS = [
  { label: "dall-e-3", description: "DALL-E 3 — OpenAI 出品，构图与理解力强" },
  { label: "flux-1-pro", description: "Flux 1 Pro — 开源模型，画质细腻" },
];

if (!apiKey) {
  const askPayload = {
    __ask_user: {
      for: "image_config",
      question: "缺少预览图生成 API 配置。请提供 API Key，或选择你想使用的图片模型（需要模型对应的 API Key）。",
      fields: [
        { name: "apiKey", label: "API Key", description: "IMAGE_API_KEY（或 LLM_API_KEY）", type: "secret" },
        { name: "baseUrl", label: "API Base URL（可选）", description: "留空使用默认：https://api.openai.com", type: "text" },
      ],
      options: DEFAULT_IMAGE_MODELS.map(m => ({ label: m.label, description: m.description })),
    },
  };
  console.log(JSON.stringify(askPayload));
  process.exit(2);
}

const outputDir = values["output-dir"];
await Bun.write(`${outputDir}/.gitkeep`, "");

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

async function generateImage(prompt: string, outputPath: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: `Cinematic storyboard frame: ${prompt}. High quality, 16:9 aspect ratio, film lighting.`,
      n: 1,
      size: "1792x1024",
    }),
  });

  if (!response.ok) {
    throw new Error(`Image API error: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const imageUrl = result.data?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in response");

  const imgResponse = await fetch(imageUrl);
  const buffer = await imgResponse.arrayBuffer();
  await Bun.write(outputPath, buffer);
}

const results: Array<{ index: number; previewImageUrl: string; error?: string }> = [];

for (const shot of storyboard.shots) {
  const outputPath = `${outputDir}/shot-${shot.index}.png`;
  console.error(`Generating preview for shot ${shot.index}...`);
  try {
    await generateImage(shot.prompt, outputPath);
    results.push({ index: shot.index, previewImageUrl: outputPath });
    console.error(`  ✅ Shot ${shot.index} saved to ${outputPath}`);
  } catch (err: any) {
    console.error(`  ❌ Shot ${shot.index} failed: ${err.message}`);
    results.push({ index: shot.index, previewImageUrl: "", error: err.message });
  }
}

for (const r of results) {
  const shot = storyboard.shots.find((s: any) => s.index === r.index);
  if (shot) {
    shot.previewImageUrl = r.previewImageUrl;
    shot.status = r.error ? "error" : "image_generating";
    if (r.error) shot.error = r.error;
  }
}

storyboard.status = "preview_ready";
await Bun.write(values.storyboard, JSON.stringify(storyboard, null, 2));

console.log(JSON.stringify({ results, storyboard }));

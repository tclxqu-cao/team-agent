#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    storyboard: { type: "string" },
    "output-dir": { type: "string" },
  },
});

if (!values.storyboard || !values["output-dir"]) {
  console.error("Usage: render-preview.ts --storyboard <path> --output-dir <dir>");
  process.exit(1);
}

const outputDir = values["output-dir"];
await Bun.write(`${outputDir}/.gitkeep`, "");

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

const apiKey = process.env.IMAGE_API_KEY ?? process.env.LLM_API_KEY ?? "";
const baseUrl = process.env.IMAGE_BASE_URL ?? process.env.LLM_BASE_URL ?? "https://api.openai.com";

async function generateImage(prompt: string, outputPath: string): Promise<void> {
  // Use DALL-E / compatible image API
  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.IMAGE_MODEL ?? "dall-e-3",
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

  // Download image
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

// Update storyboard with preview URLs
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

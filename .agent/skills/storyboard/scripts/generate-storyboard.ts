#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    materials: { type: "string" },
    direction: { type: "string" },
    output: { type: "string" },
  },
});

if (!values.materials || !values.output) {
  console.error("Usage: generate-storyboard.ts --materials <text> --direction <text> --output <path>");
  process.exit(1);
}

// Read API config from environment
const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const baseUrl = process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const model = process.env.LLM_MODEL ?? "gpt-4o";

const prompt = `You are a professional video storyboard director.
Given the following materials and creative direction, generate a structured storyboard as JSON.

Materials:
${values.materials}

Creative Direction:
${values.direction ?? "Auto-determine based on materials"}

Output a JSON object with this exact structure:
{
  "title": "<video title>",
  "shots": [
    {
      "index": 1,
      "description": "<Chinese description of what happens in this shot>",
      "prompt": "<English prompt for AI image/video generation, be specific about composition, lighting, camera movement>",
      "duration": 5,
      "status": "pending"
    }
  ]
}

Rules:
- Generate 4-8 shots depending on content richness
- Each shot should be 5 seconds (Seedance 1 Lite standard)
- Prompts should be detailed, cinematic, in English
- Descriptions should be in Chinese for the user
- Output ONLY valid JSON, no markdown fences`;

const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
  }),
});

if (!response.ok) {
  const err = await response.text();
  console.error(`LLM API error: ${response.status} ${err}`);
  process.exit(1);
}

const result = await response.json();
const content = result.choices?.[0]?.message?.content ?? "";

// Parse JSON from response (strip markdown fences if present)
const jsonStr = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
const storyboard = JSON.parse(jsonStr);

// Add default fields
storyboard.status = "generating";
storyboard.id = `sb-${Date.now()}`;
for (const shot of storyboard.shots) {
  shot.status = shot.status ?? "pending";
}

await Bun.write(values.output, JSON.stringify(storyboard, null, 2));

// Output to stdout for the agent
console.log(JSON.stringify(storyboard));

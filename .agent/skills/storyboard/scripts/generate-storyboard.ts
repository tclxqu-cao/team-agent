#!/usr/bin/env bun
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    materials: { type: "string" },
    direction: { type: "string" },
    output: { type: "string" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
  },
});

if (!values.materials || !values.output) {
  console.error("Usage: generate-storyboard.ts --materials <text> --direction <text> --output <path> [--api-key <key>] [--base-url <url>] [--model <id>]");
  process.exit(1);
}

const apiKey = values["api-key"] ?? process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const baseUrl = values["base-url"] ?? process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const model = values.model ?? process.env.LLM_MODEL ?? "gpt-4o";

const DEFAULT_STORYBOARD_MODELS = [
  { label: "gpt-4o", description: "GPT-4o — 综合能力强，适合大多数故事板生成" },
  { label: "claude-sonnet-4-20250514", description: "Claude Sonnet 4 — 创意叙述优秀，中文理解好" },
  { label: "gemini-2.5-pro", description: "Gemini 2.5 Pro — 多模态能力强，长上下文佳" },
];

if (!apiKey) {
  const askPayload = {
    __ask_user: {
      for: "storyboard_config",
      question: "缺少故事板 LLM API 配置。请提供 API Key，并可选择或直接输入模型 ID。",
      fields: [
        { name: "apiKey", label: "API Key", description: "LLM_API_KEY（或 OPENAI_API_KEY）", type: "secret" },
        { name: "model", label: "模型 ID", description: "可手动输入模型，例如 gpt-4o、claude-sonnet-4-20250514、gemini-2.5-pro；留空使用所选推荐或默认 gpt-4o", type: "text" },
        { name: "baseUrl", label: "API Base URL（可选）", description: "留空使用默认：https://api.openai.com", type: "text" },
      ],
      options: DEFAULT_STORYBOARD_MODELS.map(m => ({ label: m.label, description: `${m.description}。选择后会作为模型默认值，也可以在模型 ID 中手动覆盖。` })),
    },
  };
  console.log(JSON.stringify(askPayload));
  process.exit(2);
}

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
- Each shot should be 5 seconds
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

const jsonStr = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
const storyboard = JSON.parse(jsonStr);

storyboard.status = "generating";
storyboard.id = `sb-${Date.now()}`;
for (const shot of storyboard.shots) {
  shot.status = shot.status ?? "pending";
}

await Bun.write(values.output, JSON.stringify(storyboard, null, 2));
console.log(JSON.stringify(storyboard));

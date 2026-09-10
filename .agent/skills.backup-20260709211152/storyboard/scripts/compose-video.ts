#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "videos-dir": { type: "string" },
    storyboard: { type: "string" },
    output: { type: "string" },
  },
});

if (!values["videos-dir"] || !values.storyboard || !values.output) {
  console.error("Usage: compose-video.ts --videos-dir <dir> --storyboard <path> --output <path>");
  process.exit(1);
}

const sbContent = await Bun.file(values.storyboard).text();
const storyboard = JSON.parse(sbContent);

// Get sorted, successful shots
const shots = storyboard.shots
  .filter((s: any) => s.videoUrl && s.status === "done")
  .sort((a: any, b: any) => a.index - b.index);

if (shots.length === 0) {
  console.error("No completed video clips to compose");
  process.exit(1);
}

// Create FFmpeg concat file
const concatPath = `${values["videos-dir"]}/concat.txt`;
const concatContent = shots.map((s: any) => `file '${s.videoUrl}'`).join("\n");
await Bun.write(concatPath, concatContent);

// Run FFmpeg to concat with crossfade transitions
// For MVP: simple concat demuxer with fade transitions
function runFFmpeg(): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      values.output!,
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    proc.on("error", reject);
  });
}

console.error("Composing final video...");
try {
  await runFFmpeg();
  console.error(`✅ Final video saved to ${values.output}`);

  // Update storyboard
  storyboard.status = "composed";
  storyboard.composedVideoUrl = values.output;
  await Bun.write(values.storyboard, JSON.stringify(storyboard, null, 2));

  console.log(JSON.stringify({ output: values.output, storyboard }));
} catch (err: any) {
  console.error(`❌ Composition failed: ${err.message}`);
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}

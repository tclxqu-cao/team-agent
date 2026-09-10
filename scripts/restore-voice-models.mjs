import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/desktop/.agent-data/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30");
const destination = process.argv[2] ? resolve(process.argv[2]) : source;

async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const manifest = JSON.parse(await readFile(join(source, "encoder-parts.json"), "utf8"));
  if (manifest.file !== "encoder.int8.onnx"
    || !Number.isSafeInteger(manifest.size) || manifest.size <= 0
    || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !Array.isArray(manifest.parts) || manifest.parts.length === 0
    || manifest.parts.some((part) => typeof part.file !== "string"
      || basename(part.file) !== part.file || !/^encoder\.int8\.onnx\.part-\d{3}$/.test(part.file)
      || !Number.isSafeInteger(part.size) || part.size <= 0)) {
    throw new Error("Invalid encoder parts manifest");
  }
  await mkdir(destination, { recursive: true });
  const target = join(destination, manifest.file);
  const existing = await stat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) {
    if (existing.size !== manifest.size || await checksum(target) !== manifest.sha256) {
      throw new Error(`Existing model does not match; preserve or remove it before retrying: ${target}`);
    }
    console.log(`Model already verified: ${target}`);
    return;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const output = await open(temporary, "wx");
  try {
    for (const part of manifest.parts) {
      const path = join(source, part.file);
      if ((await stat(path)).size !== part.size) throw new Error(`Invalid part size: ${part.file}`);
      for await (const chunk of createReadStream(path)) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error("Could not write encoder model");
          offset += bytesWritten;
        }
      }
    }
    await output.close();
    if ((await stat(temporary)).size !== manifest.size || await checksum(temporary) !== manifest.sha256) {
      throw new Error("Restored encoder SHA-256 mismatch");
    }
    await rename(temporary, target);
    console.log(`Model restored and SHA-256 verified: ${target}`);
  } finally {
    await output.close();
    await rm(temporary, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

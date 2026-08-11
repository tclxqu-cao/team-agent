import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface AsrModelFiles {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface TtsModelFiles {
  model: string;
  tokens: string;
  lexicon: string;
  dictDir: string;
}

export function findAsrModelFiles(modelDir: string): AsrModelFiles {
  const dir = resolve(modelDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`ASR model directory does not exist: ${dir}`);
  }
  const names = readdirSync(dir);
  const match = (pattern: RegExp) => {
    const name = names.find((candidate) => pattern.test(candidate));
    return name ? resolve(dir, name) : null;
  };
  const candidates = {
    encoder: match(/^encoder.*\.onnx$/),
    decoder: match(/^decoder.*\.onnx$/),
    joiner: match(/^joiner.*\.onnx$/),
    tokens: match(/^tokens\.txt$/),
  };
  const missing = Object.entries(candidates)
    .filter(([, path]) => path === null)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`ASR model is missing: ${missing.join(", ")}`);
  return candidates as AsrModelFiles;
}

export function findTtsModelFiles(modelDir: string): TtsModelFiles {
  const dir = resolve(modelDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`TTS model directory does not exist: ${dir}`);
  }
  const required = {
    model: resolve(dir, "model.onnx"),
    tokens: resolve(dir, "tokens.txt"),
    lexicon: resolve(dir, "lexicon.txt"),
    dictDir: resolve(dir, "dict"),
  };
  const missing = Object.entries(required)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`TTS model is missing: ${missing.join(", ")}`);
  return required;
}

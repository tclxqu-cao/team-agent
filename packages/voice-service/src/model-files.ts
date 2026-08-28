import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface AsrModelFiles {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface KwsModelFiles extends AsrModelFiles {
  keywords: string;
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

export function findKwsModelFiles(modelDir: string): KwsModelFiles {
  const dir = resolve(modelDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`KWS model directory does not exist: ${dir}`);
  }
  const names = readdirSync(dir);
  const match = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const name = names.find((candidate) => pattern.test(candidate));
      if (name) return resolve(dir, name);
    }
    return null;
  };
  const modelNames = names.filter((name) => /^(encoder|decoder|joiner).*\.onnx$/.test(name));
  const requiredNames = {
    encoder: modelNames.some((name) => name.startsWith("encoder")),
    decoder: modelNames.some((name) => name.startsWith("decoder")),
    joiner: modelNames.some((name) => name.startsWith("joiner")),
    tokens: names.includes("tokens.txt"),
    keywords: names.includes("keywords.txt"),
  };
  const missingNames = Object.entries(requiredNames)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missingNames.length > 0) throw new Error(`KWS model is missing: ${missingNames.join(", ")}`);
  const modelKey = (name: string) => name
    .replace(/^(encoder|decoder|joiner)-?/, "")
    .replace(/\.int8\.onnx$/, "")
    .replace(/\.onnx$/, "");
  const completeKey = [...new Set(modelNames.map(modelKey))]
    .sort()
    .find((key) => ["encoder", "decoder", "joiner"].every((component) => (
      modelNames.some((name) => name.startsWith(component) && modelKey(name) === key)
    )));
  if (completeKey === undefined) {
    throw new Error("KWS model is missing a matching encoder, decoder, joiner set");
  }
  const component = (prefix: "encoder" | "decoder" | "joiner") => {
    const matches = modelNames
      .filter((name) => name.startsWith(prefix) && modelKey(name) === completeKey)
      .sort((left, right) => Number(right.includes(".int8.")) - Number(left.includes(".int8.")));
    return resolve(dir, matches[0]);
  };
  const candidates = {
    encoder: component("encoder"),
    decoder: component("decoder"),
    joiner: component("joiner"),
    tokens: match([/^tokens\.txt$/]),
    keywords: match([/^keywords\.txt$/]),
  };
  const missing = Object.entries(candidates)
    .filter(([, path]) => path === null)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`KWS model is missing: ${missing.join(", ")}`);
  return candidates as KwsModelFiles;
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

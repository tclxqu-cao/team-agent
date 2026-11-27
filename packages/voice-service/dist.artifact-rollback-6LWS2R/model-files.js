import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
export function findAsrModelFiles(modelDir) {
    const dir = resolve(modelDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`ASR model directory does not exist: ${dir}`);
    }
    const names = readdirSync(dir);
    const match = (pattern) => {
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
    if (missing.length > 0)
        throw new Error(`ASR model is missing: ${missing.join(", ")}`);
    return candidates;
}
export function findKwsModelFiles(modelDir) {
    const dir = resolve(modelDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`KWS model directory does not exist: ${dir}`);
    }
    const names = readdirSync(dir);
    const match = (patterns) => {
        for (const pattern of patterns) {
            const name = names.find((candidate) => pattern.test(candidate));
            if (name)
                return resolve(dir, name);
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
    if (missingNames.length > 0)
        throw new Error(`KWS model is missing: ${missingNames.join(", ")}`);
    const modelKey = (name) => name
        .replace(/^(encoder|decoder|joiner)-?/, "")
        .replace(/\.int8\.onnx$/, "")
        .replace(/\.onnx$/, "");
    const completeKey = [...new Set(modelNames.map(modelKey))]
        .sort()
        .find((key) => ["encoder", "decoder", "joiner"].every((component) => (modelNames.some((name) => name.startsWith(component) && modelKey(name) === key))));
    if (completeKey === undefined) {
        throw new Error("KWS model is missing a matching encoder, decoder, joiner set");
    }
    const component = (prefix) => {
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
    if (missing.length > 0)
        throw new Error(`KWS model is missing: ${missing.join(", ")}`);
    return candidates;
}
//# sourceMappingURL=model-files.js.map
import { pathToFileURL } from "node:url";

export function normalizeTranscript(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(left[i - 1] !== right[j - 1]),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function characterScore(referenceText, hypothesisText) {
  const reference = normalizeTranscript(referenceText);
  const hypothesis = normalizeTranscript(hypothesisText);
  const distance = editDistance(reference, hypothesis);
  const accuracy = reference.length === 0
    ? Number(hypothesis.length === 0)
    : Math.max(0, 1 - distance / reference.length);
  return {
    accuracy: Number(accuracy.toFixed(4)),
    distance,
    hypothesis,
    reference,
    referenceCharacters: reference.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reference, hypothesis] = process.argv.slice(2);
  if (reference === undefined || hypothesis === undefined) {
    process.stderr.write("Usage: node evaluate.mjs <reference> <hypothesis>\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(characterScore(reference, hypothesis))}\n`);
  }
}

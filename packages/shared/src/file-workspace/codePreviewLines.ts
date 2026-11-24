// Chunks can end in the middle of a source line, including between CR and LF.
export function codePreviewLines(chunks: readonly string[]): string[] {
  const lines = [""];
  for (const chunk of chunks) {
    const parts = chunk.split("\n");
    lines[lines.length - 1] += parts[0];
    for (let index = 1; index < parts.length; index += 1) lines.push(parts[index]);
  }
  return lines;
}

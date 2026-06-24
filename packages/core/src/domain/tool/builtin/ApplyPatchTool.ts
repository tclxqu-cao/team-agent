import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let currentFile: FilePatch | null = null;
  let currentHunk: Hunk | null = null;
  let afterHeader = false;

  const lines = patch.split("\n");

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (currentFile && currentFile.hunks.length > 0) {
        files.push(currentFile);
      }
      currentFile = {
        oldPath: line.slice(4).replace(/^\t/, ""),
        newPath: "",
        hunks: [],
      };
      afterHeader = true;
    } else if (line.startsWith("+++ ") && currentFile) {
      currentFile.newPath = line.slice(4).replace(/^\t/, "");
      afterHeader = false;
    } else if (line.startsWith("@@ ") && currentFile) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        currentHunk = {
          oldStart: parseInt(m[1], 10),
          oldLines: [],
          newStart: parseInt(m[3], 10),
          newLines: [],
        };
        currentFile.hunks.push(currentHunk);
      }
    } else if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        currentHunk.oldLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        const ctx = line.slice(1);
        currentHunk.oldLines.push(ctx);
        currentHunk.newLines.push(ctx);
      }
      // Skip empty/separator lines between hunks
    }
  }

  if (currentFile && currentFile.hunks.length > 0) {
    files.push(currentFile);
  }

  return files;
}

function seekSequence(lines: string[], pattern: string[], startIdx: number, isEof: boolean): number | null {
  for (let i = startIdx; i <= lines.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  // Try an end-of-file search: allow the pattern to match past the last line
  if (isEof && startIdx <= lines.length) {
    for (let i = Math.max(startIdx, lines.length - pattern.length); i <= lines.length; i++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        const actual = i + j < lines.length ? lines[i + j] : "";
        if (actual !== pattern[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
  }
  return null;
}

function computeReplacements(
  originalLines: string[],
  hunks: Hunk[],
  filePath: string,
): Array<{ startIdx: number; oldLen: number; newLines: string[] }> {
  const replacements: Array<{ startIdx: number; oldLen: number; newLines: string[] }> = [];
  let lineIndex = 0;

  for (const hunk of hunks) {
    // Try to locate the old lines in the file
    // If hunk has context (oldLines[0] is a context line from the diff), we
    // use seekSequence to skip to that context first
    let pattern = hunk.oldLines;
    let newSlice = hunk.newLines;

    // The hunk starts at oldStart (1-based). Try that position first
    const preferredStart = Math.max(0, hunk.oldStart - 1);
    let found: number | null = null;

    if (pattern.length > 0) {
      found = seekSequence(originalLines, pattern, preferredStart, false);
    }

    // Fallback: if not found and the pattern ends with empty string (EOF sentinel),
    // retry without it
    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      const trimmedPattern = pattern.slice(0, -1);
      let trimmedNew = newSlice;
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        trimmedNew = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, trimmedPattern, preferredStart, true);
      if (found !== null) {
        pattern = trimmedPattern;
        newSlice = trimmedNew;
      }
    }

    if (found === null) {
      // Try from the start of the file as a last resort
      found = seekSequence(originalLines, pattern, 0, true);
    }

    if (found !== null) {
      replacements.push({ startIdx: found, oldLen: pattern.length, newLines: newSlice });
      lineIndex = found + pattern.length;
    } else {
      // If oldLines is empty, it's a pure addition (new file or append)
      if (hunk.oldLines.length === 0) {
        const insertIdx = originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
        replacements.push({ startIdx: insertIdx, oldLen: 0, newLines: hunk.newLines });
      } else {
        throw new Error(
          `Failed to find expected lines in ${filePath}:\n${hunk.oldLines.join("\n")}`,
        );
      }
    }
  }

  // Sort by start index ascending (will apply in reverse)
  replacements.sort((a, b) => a.startIdx - b.startIdx);
  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<{ startIdx: number; oldLen: number; newLines: string[] }>,
): string[] {
  // Apply in reverse order so earlier replacements don't shift positions
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { startIdx, oldLen, newLines: newSlice } = replacements[i];

    // Remove old lines
    lines.splice(startIdx, oldLen);

    // Insert new lines
    for (let j = 0; j < newSlice.length; j++) {
      lines.splice(startIdx + j, 0, newSlice[j]);
    }
  }

  return lines;
}

/**
 * Apply a unified diff / patch to one or more files.
 *
 * Based on Codex's `apply_patch` mechanism:
 * - Line-based exact matching (not arbitrary string matching)
 * - Supports multiple hunks per file and multiple files per patch
 * - Applies replacements in reverse order to preserve line numbering
 * - Uses context lines for positioning
 */
export class ApplyPatchTool implements ITool {
  readonly name = "apply_patch";
  readonly description = `Apply a unified diff / patch to files.

Takes a patch in unified diff format (like \`git diff\` output) and applies
it using line-based exact matching. For each hunk, the tool validates that
the old lines exist exactly in the file before replacing them.

Use this for multi-hunk or multi-file edits. For a single simple edit,
str_replace may be simpler.

Format:
  --- a/file.ts
  +++ b/file.ts
  @@ -1,5 +1,7 @@
   context line
  -old line
  +new line
   context line`;

  readonly schema = z.object({
    patch: z.string().describe("The unified diff / patch to apply"),
  });

  readonly parameters = {
    type: "object",
    properties: {
      patch: { type: "string", description: "The unified diff / patch to apply" },
    },
    required: ["patch"],
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };
    }

    const { patch } = parsed.data;

    try {
      const files = parsePatch(patch);
      if (files.length === 0) {
        return { toolCallId: "", content: "No valid hunks found in patch", isError: true };
      }

      const results: string[] = [];
      const errors: string[] = [];

      for (const file of files) {
        const filePath = resolve(ctx.workingDirectory, file.newPath);

        let originalLines: string[];
        try {
          const content = await readFile(filePath, "utf-8");
          originalLines = content.split("\n");
          // Remove trailing empty element from final newline
          if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
            originalLines.pop();
          }
        } catch (err) {
          // File doesn't exist yet; treat as empty for creation case
          if (file.hunks.every((h) => h.oldLines.length === 0)) {
            originalLines = [];
          } else {
            errors.push(`File not found: ${filePath}`);
            continue;
          }
        }

        const replacements = computeReplacements(originalLines, file.hunks, filePath);
        const newLines = applyReplacements([...originalLines], replacements);

        // Ensure trailing newline
        let newContent = newLines.join("\n");
        if (!newContent.endsWith("\n")) {
          newContent += "\n";
        }

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, newContent, "utf-8");

        const hunkCount = file.hunks.length;
        results.push(`${filePath} (${hunkCount} hunk${hunkCount !== 1 ? "s" : ""})`);
      }

      if (results.length === 0) {
        return {
          toolCallId: "",
          content: errors.join("\n"),
          isError: true,
        };
      }

      let output = "Applied patch to:\n" + results.join("\n");
      if (errors.length > 0) {
        output += "\n\nErrors:\n" + errors.join("\n");
      }
      return { toolCallId: "", content: output };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Failed to apply patch",
        isError: true,
      };
    }
  }
}

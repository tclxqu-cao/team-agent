import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
/**
 * Apply a unified diff / patch to one or more files.
 *
 * Based on Codex's `apply_patch` mechanism:
 * - Line-based exact matching (not arbitrary string matching)
 * - Supports multiple hunks per file and multiple files per patch
 * - Applies replacements in reverse order to preserve line numbering
 * - Uses context lines for positioning
 */
export declare class ApplyPatchTool implements ITool {
    readonly name = "apply_patch";
    readonly description = "Apply a unified diff / patch to files.\n\nTakes a patch in unified diff format (like `git diff` output) and applies\nit using line-based exact matching. For each hunk, the tool validates that\nthe old lines exist exactly in the file before replacing them.\n\nUse this for multi-hunk or multi-file edits. For a single simple edit,\nstr_replace may be simpler.\n\nFormat:\n  --- a/file.ts\n  +++ b/file.ts\n  @@ -1,5 +1,7 @@\n   context line\n  -old line\n  +new line\n   context line";
    readonly schema: z.ZodObject<{
        patch: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        patch: string;
    }, {
        patch: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            patch: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=ApplyPatchTool.d.ts.map